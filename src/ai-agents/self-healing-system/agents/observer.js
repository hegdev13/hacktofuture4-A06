/**
 * Observer Agent
 * Detects anomalies dynamically without hardcoded conditions
 * LLM-ready design for intelligent reasoning
 */

const config = require('../config');
const logger = require('../utils/logger');

class ObserverAgent {
  constructor() {
    this.thresholds = config.severity.thresholds;
    this.anomalyHistory = new Map();
    this.metricBreaches = new Map();
    this.lastRCATriggerAt = 0;

    // Observer-side RCA trigger policy (deterministic, no LLM calls).
    this.rcaPolicy = {
      thresholds: {
        cpu: config.observer?.thresholds?.cpu ?? 80,
        memory: config.observer?.thresholds?.memory ?? 85,
        errorRate: config.observer?.thresholds?.errorRate ?? 5,
        restartCount: config.observer?.thresholds?.restartCount ?? 3,
      },
      stabilityWindowMs: config.observer?.stabilityWindowMs ?? 30_000,
      cooldownMs: config.observer?.cooldownMs ?? 60_000,
      severityTriggerScore: config.observer?.severityTriggerScore ?? 70,
      correlationSignalBonus: config.observer?.correlationSignalBonus ?? 10,
      weights: {
        cpu: config.observer?.weights?.cpu ?? 20,
        memory: config.observer?.weights?.memory ?? 20,
        errorRate: config.observer?.weights?.errorRate ?? 30,
        restartCount: config.observer?.weights?.restartCount ?? 20,
      },
    };

    this.ignoredNamespaces = new Set([
      'kube-system',
      'kube-public',
      'kube-node-lease',
      'local-path-storage',
      'ingress-nginx',
    ]);
  }

  /**
   * Analyze cluster state for issues
   * Dynamically detects anomalies without hardcoded conditions
   */
  analyzeClusterState(clusterState) {
    logger.timelineEvent('analysis', 'Starting cluster health analysis');

    const issues = [];
    const pods = (clusterState.pods || []).filter(
      (pod) => !this.ignoredNamespaces.has((pod.namespace || '').toLowerCase())
    );
    const nodes = clusterState.nodes || [];
    const metrics = clusterState.metrics || {};

    // Analyze pods
    for (const pod of pods) {
      const podIssues = this.analyzePod(pod, clusterState);
      issues.push(...podIssues);
    }

    // Analyze nodes
    for (const node of nodes) {
      const nodeIssues = this.analyzeNode(node, clusterState);
      issues.push(...nodeIssues);
    }

    // Analyze system-wide metrics
    const systemIssues = this.analyzeSystemMetrics(metrics, clusterState);
    issues.push(...systemIssues);

    // Detect cascading patterns
    const cascadingIssues = this.detectCascadingIssues(issues, clusterState);
    issues.push(...cascadingIssues);

    // Determine overall health
    const healthy = issues.length === 0 ||
                    !issues.some(i => i.severity === 'high');

    // Prioritize issues
    const sortedIssues = this.prioritizeIssues(issues);

    // Observer decides whether RCA should run now.
    const rcaDecision = this.evaluateRCATrigger(clusterState, sortedIssues);

    logger.timelineEvent(
      healthy ? 'success' : 'issue',
      `Analysis complete: ${sortedIssues.length} issue(s) detected`,
      {
        healthy,
        issueCount: sortedIssues.length,
        triggerRCA: rcaDecision.triggerRCA,
        rcaReason: rcaDecision.reason,
      }
    );

    return {
      healthy,
      issues: sortedIssues,
      summary: this.generateSummary(sortedIssues),
      rcaDecision,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Observer RCA trigger logic:
   * - sustained threshold breaches only (stability window)
   * - short spikes are ignored
   * - severity score from multi-metric signals
   * - cooldown gate to avoid repeated RCA calls
   */
  evaluateRCATrigger(clusterState, issues = []) {
    const now = Date.now();
    const snapshots = this.collectMetricSnapshots(clusterState);
    const sustainedSignals = [];
    const perResource = [];

    for (const snap of snapshots) {
      const resourceSignals = this.evaluateResourceSignals(snap, now);
      perResource.push(resourceSignals.summary);
      sustainedSignals.push(...resourceSignals.sustainedSignals);
    }

    const hasSustainedAnomaly = sustainedSignals.length > 0;
    const highestResourceScore = perResource.reduce(
      (m, r) => Math.max(m, r.severityScore || 0),
      0
    );

    const correlatedResources = perResource.filter((r) => r.sustainedSignalCount >= 2).length;
    const correlationBonus = correlatedResources > 0
      ? Math.min(20, correlatedResources * this.rcaPolicy.correlationSignalBonus)
      : 0;

    const issueSeverityBoost = issues.reduce((acc, issue) => {
      if (issue.severity === 'high') return acc + 6;
      if (issue.severity === 'medium') return acc + 3;
      return acc + 1;
    }, 0);

    const severityScore = Math.min(
      100,
      Math.round(highestResourceScore + correlationBonus + Math.min(20, issueSeverityBoost))
    );

    const inCooldown = now - this.lastRCATriggerAt < this.rcaPolicy.cooldownMs;
    const cooldownRemainingMs = inCooldown
      ? this.rcaPolicy.cooldownMs - (now - this.lastRCATriggerAt)
      : 0;

    const triggerRCA =
      hasSustainedAnomaly &&
      severityScore >= this.rcaPolicy.severityTriggerScore &&
      !inCooldown;

    let reason;
    if (!hasSustainedAnomaly) {
      reason = 'Skipped: no sustained anomaly (short spikes filtered)';
    } else if (severityScore < this.rcaPolicy.severityTriggerScore) {
      reason = `Skipped: severity ${severityScore} below trigger threshold ${this.rcaPolicy.severityTriggerScore}`;
    } else if (inCooldown) {
      reason = `Skipped: in cooldown (${Math.ceil(cooldownRemainingMs / 1000)}s remaining)`;
    } else {
      reason = `Triggered: sustained anomaly + severity ${severityScore} + cooldown satisfied`;
      this.lastRCATriggerAt = now;
    }

    return {
      triggerRCA,
      reason,
      metricsSummary: {
        thresholds: this.rcaPolicy.thresholds,
        stabilityWindowSec: Math.round(this.rcaPolicy.stabilityWindowMs / 1000),
        cooldownSec: Math.round(this.rcaPolicy.cooldownMs / 1000),
        severityScore,
        severityTriggerScore: this.rcaPolicy.severityTriggerScore,
        sustainedSignalCount: sustainedSignals.length,
        correlatedResourceCount: correlatedResources,
        sustainedSignals,
        resources: perResource,
      },
    };
  }

  /**
   * Build normalized per-resource metric snapshots.
   */
  collectMetricSnapshots(clusterState) {
    const pods = (clusterState.pods || []).filter(
      (pod) => !this.ignoredNamespaces.has((pod.namespace || '').toLowerCase())
    );

    return pods.map((pod) => {
      const logs = Array.isArray(pod.logs) ? pod.logs : [];
      const errorRateFromLogs = this.computeErrorRateFromLogs(logs);

      const cpu = Number(pod.cpu ?? pod.cpuUsage ?? 0);
      const memory = Number(pod.memory ?? pod.memoryUsage ?? 0);
      const errorRate = Number(pod.errorRate ?? errorRateFromLogs);
      const restartCount = Number(pod.restarts ?? pod.restartCount ?? 0);

      return {
        resource: `${pod.namespace || 'default'}/${pod.name}`,
        cpu,
        memory,
        errorRate,
        restartCount,
      };
    });
  }

  /**
   * Lightweight log-error ratio as a percentage.
   */
  computeErrorRateFromLogs(logs) {
    if (!Array.isArray(logs) || logs.length === 0) return 0;
    const errorPatterns = [/error/i, /fatal/i, /panic/i, /exception/i, /timeout/i, /refused/i];
    let errorCount = 0;

    for (const entry of logs.slice(-100)) {
      const text = typeof entry === 'string' ? entry : (entry?.message || '');
      if (errorPatterns.some((rx) => rx.test(text))) errorCount++;
    }

    return (errorCount / Math.min(logs.length, 100)) * 100;
  }

  /**
   * Track sustained threshold breaches per resource/metric.
   */
  updateBreachState(key, isBreached, value, now) {
    const existing = this.metricBreaches.get(key);

    if (!isBreached) {
      this.metricBreaches.delete(key);
      return {
        sustained: false,
        durationMs: 0,
        maxValue: 0,
      };
    }

    if (!existing) {
      const next = { firstBreachAt: now, lastSeenAt: now, maxValue: value };
      this.metricBreaches.set(key, next);
      return {
        sustained: false,
        durationMs: 0,
        maxValue: value,
      };
    }

    existing.lastSeenAt = now;
    existing.maxValue = Math.max(existing.maxValue, value);
    const durationMs = now - existing.firstBreachAt;

    return {
      sustained: durationMs >= this.rcaPolicy.stabilityWindowMs,
      durationMs,
      maxValue: existing.maxValue,
    };
  }

  /**
   * Convert sustained metric breaches into resource-level severity score.
   */
  evaluateResourceSignals(snapshot, now) {
    const t = this.rcaPolicy.thresholds;
    const checks = [
      { metric: 'cpu', value: snapshot.cpu, threshold: t.cpu },
      { metric: 'memory', value: snapshot.memory, threshold: t.memory },
      { metric: 'errorRate', value: snapshot.errorRate, threshold: t.errorRate },
      { metric: 'restartCount', value: snapshot.restartCount, threshold: t.restartCount },
    ];

    const sustainedSignals = [];
    let severityScore = 0;

    for (const check of checks) {
      const breached = check.value > check.threshold;
      const key = `${snapshot.resource}:${check.metric}`;
      const breachState = this.updateBreachState(key, breached, check.value, now);

      if (!breachState.sustained) continue;

      const overRatio = check.threshold > 0
        ? Math.max(0, (check.value - check.threshold) / check.threshold)
        : 0;
      const metricWeight = this.rcaPolicy.weights[check.metric] || 10;
      const metricScore = Math.min(metricWeight + 15, metricWeight + Math.round(overRatio * 30));
      severityScore += metricScore;

      sustainedSignals.push({
        resource: snapshot.resource,
        metric: check.metric,
        value: check.value,
        threshold: check.threshold,
        durationSec: Math.round(breachState.durationMs / 1000),
      });
    }

    if (sustainedSignals.length >= 2) {
      severityScore += 10;
    }

    return {
      sustainedSignals,
      summary: {
        resource: snapshot.resource,
        cpu: snapshot.cpu,
        memory: snapshot.memory,
        errorRate: snapshot.errorRate,
        restartCount: snapshot.restartCount,
        sustainedSignalCount: sustainedSignals.length,
        severityScore: Math.min(100, Math.round(severityScore)),
      },
    };
  }

  /**
   * Analyze a single pod
   */
  analyzePod(pod, clusterState) {
    const issues = [];
    const checks = [
      { method: this.checkPodStatus, name: 'status' },
      { method: this.checkResourceUsage, name: 'resources' },
      { method: this.checkRestartPattern, name: 'restarts' },
      { method: this.checkLogs, name: 'logs' },
      { method: this.checkReadiness, name: 'readiness' },
      { method: this.checkDependencyHealth, name: 'dependencies' },
    ];

    for (const check of checks) {
      try {
        const result = check.method.call(this, pod, clusterState);
        if (result) {
          if (Array.isArray(result)) {
            issues.push(...result);
          } else {
            issues.push(result);
          }
        }
      } catch (error) {
        logger.debug(`Check ${check.name} failed for ${pod.name}`, error);
      }
    }

    return issues;
  }

  /**
   * Check pod status
   */
  checkPodStatus(pod, clusterState) {
    const status = (pod.status || pod.phase || '').toLowerCase();
    const issues = [];

    if (status === 'failed') {
      issues.push({
        pod: pod.name,
        namespace: pod.namespace,
        target: pod.name,
        type: 'pod_failure',
        problem: `Pod in Failed state`,
        severity: 'high',
        metric: 'status',
        details: { phase: status },
      });
    } else if (status === 'pending') {
      // Check how long it's been pending
      const pendingTime = this.calculatePendingTime(pod);
      if (pendingTime > 300) { // 5 minutes
        issues.push({
          pod: pod.name,
          namespace: pod.namespace,
          target: pod.name,
          type: 'pod_pending',
          problem: `Pod stuck pending for ${Math.round(pendingTime / 60)} minutes`,
          severity: 'medium',
          metric: 'pending_time',
          details: { phase: status, pendingTime },
        });
      }
    } else if (status === 'unknown') {
      issues.push({
        pod: pod.name,
        namespace: pod.namespace,
        target: pod.name,
        type: 'pod_unknown',
        problem: 'Pod status unknown',
        severity: 'medium',
        metric: 'status',
        details: { phase: status },
      });
    }

    // Check for CrashLoopBackOff
    if (status.includes('crash') || status.includes('backoff')) {
      issues.push({
        pod: pod.name,
        namespace: pod.namespace,
        target: pod.name,
        type: 'crash_loop',
        problem: 'Pod in CrashLoopBackOff',
        severity: 'high',
        metric: 'restarts',
        details: { phase: status },
      });
    }

    return issues;
  }

  /**
   * Check resource usage
   */
  checkResourceUsage(pod, clusterState) {
    const issues = [];
    const cpu = pod.cpu || 0;
    const memory = pod.memory || 0;

    // CPU checks
    if (cpu > this.thresholds.cpu.critical) {
      issues.push({
        pod: pod.name,
        namespace: pod.namespace,
        target: pod.name,
        type: 'high_cpu',
        problem: `Critical CPU usage: ${cpu}%`,
        severity: 'high',
        metric: 'cpu',
        value: cpu,
        details: { cpu, threshold: this.thresholds.cpu.critical },
      });
    } else if (cpu > this.thresholds.cpu.high) {
      issues.push({
        pod: pod.name,
        namespace: pod.namespace,
        target: pod.name,
        type: 'elevated_cpu',
        problem: `High CPU usage: ${cpu}%`,
        severity: 'medium',
        metric: 'cpu',
        value: cpu,
        details: { cpu, threshold: this.thresholds.cpu.high },
      });
    }

    // Memory checks
    if (memory > this.thresholds.memory.critical) {
      issues.push({
        pod: pod.name,
        namespace: pod.namespace,
        target: pod.name,
        type: 'high_memory',
        problem: `Critical memory usage: ${memory}%`,
        severity: 'high',
        metric: 'memory',
        value: memory,
        details: { memory, threshold: this.thresholds.memory.critical },
      });
    } else if (memory > this.thresholds.memory.high) {
      issues.push({
        pod: pod.name,
        namespace: pod.namespace,
        target: pod.name,
        type: 'elevated_memory',
        problem: `High memory usage: ${memory}%`,
        severity: 'medium',
        metric: 'memory',
        value: memory,
        details: { memory, threshold: this.thresholds.memory.high },
      });
    }

    return issues;
  }

  /**
   * Check restart patterns
   */
  checkRestartPattern(pod, clusterState) {
    const restarts = pod.restarts || 0;
    const issues = [];

    if (restarts >= this.thresholds.restarts.critical) {
      issues.push({
        pod: pod.name,
        namespace: pod.namespace,
        target: pod.name,
        type: 'excessive_restarts',
        problem: `Critical restart count: ${restarts}`,
        severity: 'high',
        metric: 'restarts',
        value: restarts,
        details: { restarts, threshold: this.thresholds.restarts.critical },
      });
    } else if (restarts >= this.thresholds.restarts.warning) {
      issues.push({
        pod: pod.name,
        namespace: pod.namespace,
        target: pod.name,
        type: 'frequent_restarts',
        problem: `Elevated restart count: ${restarts}`,
        severity: 'medium',
        metric: 'restarts',
        value: restarts,
        details: { restarts, threshold: this.thresholds.restarts.warning },
      });
    }

    return issues;
  }

  /**
   * Check logs for errors
   */
  checkLogs(pod, clusterState) {
    const logs = pod.logs || [];
    const issues = [];

    if (!Array.isArray(logs)) return issues;

    const errorPatterns = [
      /out of memory/i,
      /oom killed/i,
      /connection refused/i,
      /timeout/i,
      /error/i,
      /fatal/i,
      /panic/i,
    ];

    let errorCount = 0;
    let lastError = null;

    for (const log of logs.slice(-50)) { // Check last 50 log entries
      const message = typeof log === 'string' ? log : log.message || '';

      for (const pattern of errorPatterns) {
        if (pattern.test(message)) {
          errorCount++;
          lastError = message;
          break;
        }
      }
    }

    if (errorCount > 0) {
      const severity = errorCount > 10 ? 'high' : (errorCount > 3 ? 'medium' : 'low');
      issues.push({
        pod: pod.name,
        namespace: pod.namespace,
        target: pod.name,
        type: 'log_errors',
        problem: `Found ${errorCount} errors in logs`,
        severity,
        metric: 'error_rate',
        value: errorCount,
        details: { errorCount, lastError },
      });
    }

    return issues;
  }

  /**
   * Check readiness state
   */
  checkReadiness(pod, clusterState) {
    if (pod.ready === false) {
      return {
        pod: pod.name,
        namespace: pod.namespace,
        target: pod.name,
        type: 'not_ready',
        problem: 'Pod not ready',
        severity: 'medium',
        metric: 'readiness',
        details: { ready: false },
      };
    }
    return null;
  }

  /**
   * Check dependency health
   */
  checkDependencyHealth(pod, clusterState) {
    const issues = [];
    const deps = pod.dependencies || [];

    for (const dep of deps) {
      // Check if dependency target is healthy
      const depHealthy = this.checkDependencyStatus(dep.target, clusterState);

      if (!depHealthy) {
        issues.push({
          pod: pod.name,
          namespace: pod.namespace,
          target: pod.name,
          type: 'dependency_unhealthy',
          problem: `Dependency ${dep.target} (${dep.type}) unhealthy`,
          severity: 'medium',
          metric: 'dependency',
          details: { dependency: dep.target, type: dep.type },
        });
      }
    }

    return issues;
  }

  /**
   * Analyze node health
   */
  analyzeNode(node, clusterState) {
    const issues = [];
    const status = (node.status || '').toLowerCase();

    if (status !== 'ready' && status !== 'true') {
      issues.push({
        node: node.name,
        target: node.name,
        type: 'node_not_ready',
        problem: `Node ${node.name} is ${status}`,
        severity: 'high',
        metric: 'node_status',
        details: { status },
      });
    }

    // Check node resource pressure
    const conditions = node.conditions || [];
    for (const condition of conditions) {
      if (condition.type === 'MemoryPressure' && condition.status === 'True') {
        issues.push({
          node: node.name,
          target: node.name,
          type: 'node_memory_pressure',
          problem: `Node ${node.name} has memory pressure`,
          severity: 'high',
          metric: 'memory_pressure',
        });
      }
      if (condition.type === 'DiskPressure' && condition.status === 'True') {
        issues.push({
          node: node.name,
          target: node.name,
          type: 'node_disk_pressure',
          problem: `Node ${node.name} has disk pressure`,
          severity: 'high',
          metric: 'disk_pressure',
        });
      }
    }

    return issues;
  }

  /**
   * Analyze system-wide metrics
   */
  analyzeSystemMetrics(metrics, clusterState) {
    const issues = [];

    // Check cluster-wide CPU
    const clusterCPU = metrics.cluster?.cpuUsage;
    if (clusterCPU && clusterCPU > 90) {
      issues.push({
        target: 'cluster',
        type: 'cluster_high_cpu',
        problem: `Cluster-wide high CPU: ${clusterCPU}%`,
        severity: 'high',
        metric: 'cluster_cpu',
        value: clusterCPU,
      });
    }

    // Check cluster-wide memory
    const clusterMemory = metrics.cluster?.memoryUsage;
    if (clusterMemory && clusterMemory > 90) {
      issues.push({
        target: 'cluster',
        type: 'cluster_high_memory',
        problem: `Cluster-wide high memory: ${clusterMemory}%`,
        severity: 'high',
        metric: 'cluster_memory',
        value: clusterMemory,
      });
    }

    return issues;
  }

  /**
   * Detect cascading issues
   */
  detectCascadingIssues(issues, clusterState) {
    const cascading = [];
    const byNamespace = this.groupByNamespace(issues);

    for (const [namespace, nsIssues] of Object.entries(byNamespace)) {
      if (nsIssues.length >= 3) {
        cascading.push({
          target: namespace,
          type: 'cascading_failure',
          problem: `Multiple issues in namespace ${namespace}: ${nsIssues.length} problems detected`,
          severity: 'high',
          metric: 'cascade',
          details: { issueCount: nsIssues.length, namespace },
        });
      }
    }

    return cascading;
  }

  /**
   * Prioritize issues
   */
  prioritizeIssues(issues) {
    const severityOrder = { high: 0, medium: 1, low: 2 };

    return issues.sort((a, b) => {
      // First by severity
      const sevDiff = (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3);
      if (sevDiff !== 0) return sevDiff;

      // Then by whether they affect multiple pods
      const aMulti = a.details?.issueCount || 0;
      const bMulti = b.details?.issueCount || 0;
      return bMulti - aMulti;
    });
  }

  /**
   * Generate summary
   */
  generateSummary(issues) {
    const bySeverity = issues.reduce((acc, issue) => {
      acc[issue.severity] = (acc[issue.severity] || 0) + 1;
      return acc;
    }, {});

    const byType = issues.reduce((acc, issue) => {
      acc[issue.type] = (acc[issue.type] || 0) + 1;
      return acc;
    }, {});

    return {
      total: issues.length,
      high: bySeverity.high || 0,
      medium: bySeverity.medium || 0,
      low: bySeverity.low || 0,
      topIssues: issues.slice(0, 5).map(i => ({
        type: i.type,
        target: i.target,
        severity: i.severity,
      })),
      issueTypes: byType,
    };
  }

  /**
   * Helper: Check if dependency is healthy
   */
  checkDependencyStatus(target, clusterState) {
    const pods = clusterState.pods || [];
    const services = clusterState.services || [];

    // Check if target is a pod
    const pod = pods.find(p => p.name === target);
    if (pod) {
      const status = (pod.status || pod.phase || '').toLowerCase();
      return ['running', 'succeeded'].includes(status);
    }

    // Check if target is a service
    const svc = services.find(s => s.name === target);
    if (svc) {
      return svc.endpoints && svc.endpoints.length > 0;
    }

    // Unknown target - assume healthy
    return true;
  }

  /**
   * Helper: Calculate pending time
   */
  calculatePendingTime(pod) {
    const creationTime = pod.creationTime;
    if (!creationTime) return 0;

    const created = new Date(creationTime);
    const now = new Date();
    return (now - created) / 1000; // seconds
  }

  /**
   * Helper: Group issues by namespace
   */
  groupByNamespace(issues) {
    return issues.reduce((acc, issue) => {
      const ns = issue.namespace || 'unknown';
      if (!acc[ns]) acc[ns] = [];
      acc[ns].push(issue);
      return acc;
    }, {});
  }

  /**
   * Get anomaly history
   */
  getAnomalyHistory(resource) {
    return this.anomalyHistory.get(resource) || [];
  }

  /**
   * Record anomaly
   */
  recordAnomaly(resource, issue) {
    const history = this.getAnomalyHistory(resource);
    history.push({
      timestamp: new Date().toISOString(),
      issue: issue.type,
      severity: issue.severity,
    });

    // Keep last 100 entries
    if (history.length > 100) {
      history.shift();
    }

    this.anomalyHistory.set(resource, history);
  }
}

// Export singleton
module.exports = new ObserverAgent();
