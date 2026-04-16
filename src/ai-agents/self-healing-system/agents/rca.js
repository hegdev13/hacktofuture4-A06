/**
 * RCA Agent (Root Cause Analysis + orchestration report lifecycle)
 * - Runs only for trigger-worthy issues
 * - Uses dependency graph + runtime signals
 * - Maintains persistent rca_report.json history
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

class RCAAgent {
  constructor() {
    this.maxDepth = config.rca.maxChainDepth || 5;
    this.severityThreshold = config.observer?.severityTriggerScore || 70;
    this.reportPath = path.join(__dirname, '..', 'rca_report.json');
  }

  performRCA(clusterState, detectedIssues) {
    logger.timelineEvent('rca', `Starting RCA for ${detectedIssues?.length || 0} issue(s)`);

    const triggerCheck = this.shouldRunRCA(clusterState, detectedIssues || []);
    if (!triggerCheck.triggered) {
      const graph = this.buildDependencyGraph(clusterState || {});
      const nodeSignals = this.buildNodeSignals(clusterState || {}, detectedIssues || [], graph);
      const reportUpdate = this.updatePersistentReport([], graph, nodeSignals);

      const output = {
        action: reportUpdate.action,
        issues: reportUpdate.issues,
        rootCause: reportUpdate.issues[0]?.rootCause || null,
        rootCauseType: 'none',
        failureChain: [],
        confidence: reportUpdate.issues[0] ? Math.round((reportUpdate.issues[0].confidence || 0) * 100) : 0,
        confidenceScore: reportUpdate.issues[0]?.confidence || 0,
        reasoning: reportUpdate.action === 'RESOLVE' ? 'Active issue resolved and report updated' : triggerCheck.reason,
        chainDetails: [],
        affectedResources: [],
      };

      logger.timelineEvent('rca', 'RCA skipped', {
        reason: triggerCheck.reason,
        action: reportUpdate.action,
      });
      return output;
    }

    const graph = this.buildDependencyGraph(clusterState || {});
    const nodeSignals = this.buildNodeSignals(clusterState || {}, detectedIssues || [], graph);

    const roots = this.findRootCauses(graph, nodeSignals);
    const rootIssues = roots.map((rootName) =>
      this.composeIssueRecord(rootName, graph, nodeSignals, clusterState || {})
    );

    const reportUpdate = this.updatePersistentReport(rootIssues, graph, nodeSignals);

    const primary = reportUpdate.issues.find((i) => i.status === 'ACTIVE') || reportUpdate.issues[0] || null;
    const chainDetails = primary ? this.buildChainDetails(primary, nodeSignals) : [];

    const output = {
      action: reportUpdate.action,
      issues: reportUpdate.issues,
      rootCause: primary?.rootCause || null,
      rootCauseType: primary ? 'pod' : 'none',
      failureChain: primary?.failureChain || [],
      confidence: primary ? Math.round((primary.confidence || 0) * 100) : 0,
      confidenceScore: primary?.confidence || 0,
      reasoning: primary?.reasoning || reportUpdate.reason,
      chainDetails,
      affectedResources: chainDetails,
      graph: this.exportGraph(graph),
      reportPath: this.reportPath,
    };

    logger.timelineEvent('rca', 'RCA completed', {
      action: output.action,
      rootCause: output.rootCause,
      confidence: output.confidence,
      issueCount: output.issues.length,
    });

    return output;
  }

  shouldRunRCA(clusterState, detectedIssues) {
    if (!Array.isArray(detectedIssues) || detectedIssues.length === 0) {
      return { triggered: false, reason: 'No detected issues' };
    }

    const nonFlapping = detectedIssues.filter((i) => !i.isFlapping);
    if (nonFlapping.length === 0) {
      return { triggered: false, reason: 'All issues appear flapping/unstable (spike filtered)' };
    }

    const hasSelfIssue = nonFlapping.some((issue) => {
      const sev = String(issue.severity || '').toLowerCase();
      const metric = String(issue.metric || '').toLowerCase();
      const problem = String(issue.problem || '').toLowerCase();
      return sev === 'high' || metric.includes('restart') || metric.includes('status') || problem.includes('crash');
    });

    if (!hasSelfIssue) {
      return { triggered: false, reason: 'No direct selfIssue-like failures detected' };
    }

    const severityScore = nonFlapping.reduce((score, issue) => {
      const sev = String(issue.severity || '').toLowerCase();
      if (sev === 'high') return score + 35;
      if (sev === 'medium') return score + 20;
      return score + 10;
    }, 0);

    if (severityScore < this.severityThreshold) {
      return {
        triggered: false,
        reason: `Severity score ${severityScore} below threshold ${this.severityThreshold}`,
      };
    }

    return { triggered: true, reason: 'Trigger conditions satisfied (selfIssue + sustained + severity)' };
  }

  buildDependencyGraph(clusterState) {
    const graph = {
      nodes: new Set(),
      // A -> B means A depends on B
      dependencies: new Map(),
      dependents: new Map(),
    };

    const pods = clusterState.pods || [];

    for (const pod of pods) {
      const name = String(pod.name || '').trim();
      if (!name) continue;
      graph.nodes.add(name);
      if (!graph.dependencies.has(name)) graph.dependencies.set(name, new Set());
      if (!graph.dependents.has(name)) graph.dependents.set(name, new Set());
    }

    for (const pod of pods) {
      const name = String(pod.name || '').trim();
      if (!name) continue;

      const deps = Array.isArray(pod.dependencies) ? pod.dependencies : [];
      for (const dep of deps) {
        const target = String(dep?.resolvedTo || dep?.target || dep?.name || '').trim();
        if (!target) continue;

        graph.nodes.add(target);
        if (!graph.dependencies.has(target)) graph.dependencies.set(target, new Set());
        if (!graph.dependents.has(target)) graph.dependents.set(target, new Set());

        graph.dependencies.get(name).add(target);
        graph.dependents.get(target).add(name);
      }
    }

    return graph;
  }

  buildNodeSignals(clusterState, detectedIssues, graph) {
    const pods = clusterState.pods || [];
    const issuesByTarget = new Map();

    for (const issue of detectedIssues) {
      const target = String(issue.target || issue.pod || issue.node || '').trim();
      if (!target) continue;
      if (!issuesByTarget.has(target)) issuesByTarget.set(target, []);
      issuesByTarget.get(target).push(issue);
    }

    const signals = new Map();

    for (const pod of pods) {
      const name = String(pod.name || '').trim();
      if (!name) continue;

      const status = String(pod.status || pod.phase || '').toLowerCase();
      const readiness = pod.ready === true;
      const restarts = Number(pod.restarts || pod.restartCount || 0);
      const cpu = Number(pod.cpu || 0);
      const memory = Number(pod.memory || 0);
      const latency = Number(pod.latency || 0);
      const errorRate = Number(pod.errorRate || 0);
      const events = Array.isArray(pod.events) ? pod.events.map((e) => String(e)) : [];
      const logs = Array.isArray(pod.logs)
        ? pod.logs.map((l) => (typeof l === 'string' ? l : String(l?.message || '')))
        : [];

      const issueList = issuesByTarget.get(name) || [];
      const hasHighIssue = issueList.some((i) => String(i.severity || '').toLowerCase() === 'high');
      const hasDependencyIssue = issueList.some((i) => String(i.type || '').includes('dependency'));

      const selfIssue =
        status.includes('failed') ||
        status.includes('crash') ||
        status.includes('backoff') ||
        status.includes('error') ||
        !readiness ||
        restarts > (config.observer?.thresholds?.restartCount || 3) ||
        hasHighIssue;

      signals.set(name, {
        name,
        selfIssue,
        dependencyIssue: hasDependencyIssue,
        status,
        readiness,
        metrics: { cpu, memory, latency, errorRate, restartCount: restarts },
        events,
        logs,
        timestamp: clusterState.timestamp || new Date().toISOString(),
      });
    }

    // Mark dependencyIssue transitively from root self-issues.
    for (const [name, sig] of signals.entries()) {
      if (!sig.selfIssue) continue;
      const queue = [...(this.toArraySet(this.getDependents(name, graph)))];
      const seen = new Set(queue);

      while (queue.length) {
        const dep = queue.shift();
        const depSig = signals.get(dep);
        if (depSig && !depSig.selfIssue) depSig.dependencyIssue = true;

        for (const next of this.toArraySet(this.getDependents(dep, graph))) {
          if (seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
    }

    return signals;
  }

  toArraySet(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Set) return Array.from(value);
    return [];
  }

  getDependencies(nodeName, graph) {
    return graph.dependencies.get(nodeName) || new Set();
  }

  getDependents(nodeName, graph) {
    return graph.dependents.get(nodeName) || new Set();
  }

  findRootCauses(graph, nodeSignals) {
    const roots = [];

    for (const [name, sig] of nodeSignals.entries()) {
      if (!sig.selfIssue) continue;

      const deps = this.getDependencies(name, graph);
      const hasFailingDependency = Array.from(deps).some((depName) => {
        const depSig = nodeSignals.get(depName);
        return depSig?.selfIssue === true;
      });

      if (!hasFailingDependency) roots.push(name);
    }

    roots.sort((a, b) => a.localeCompare(b));
    return roots;
  }

  composeIssueRecord(rootName, graph, nodeSignals, clusterState) {
    const affectedNodes = this.collectAffectedNodes(rootName, graph, nodeSignals);
    const failureChain = this.buildFailureChain(rootName, affectedNodes, graph);
    const dependencyDepth = failureChain.length;

    const rootSignal = nodeSignals.get(rootName) || {
      events: [],
      logs: [],
      metrics: {},
      timestamp: clusterState.timestamp || new Date().toISOString(),
    };

    const failureType = this.detectFailureType(rootSignal);
    const severity = this.estimateSeverity(rootName, affectedNodes);
    const confidence = this.calculateConfidence(rootSignal, affectedNodes.length, graph, rootName);
    const timestamp = rootSignal.timestamp || new Date().toISOString();

    return {
      id: null,
      status: 'ACTIVE',
      rootCause: rootName,
      failureChain,
      affectedNodes,
      dependencyDepth,
      failureType,
      severity,
      timestamp,
      resolvedAt: null,
      confidence,
      reasoning: this.buildReasoning(rootName, failureType, affectedNodes),
    };
  }

  collectAffectedNodes(rootName, graph, nodeSignals) {
    const affected = new Set();
    const queue = [...Array.from(this.getDependents(rootName, graph))];
    const seen = new Set(queue);

    while (queue.length) {
      const current = queue.shift();
      const sig = nodeSignals.get(current);
      if (sig && (sig.dependencyIssue || sig.selfIssue)) {
        affected.add(current);
      }

      for (const next of this.getDependents(current, graph)) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }

    return Array.from(affected).sort((a, b) => a.localeCompare(b));
  }

  buildFailureChain(rootName, affectedNodes, graph) {
    if (affectedNodes.length === 0) return [rootName];

    // Build chain downstream -> ... -> root by taking longest dependent path.
    const candidate = new Set(affectedNodes);
    const distances = new Map([[rootName, 0]]);
    const parent = new Map();
    const queue = [rootName];

    while (queue.length) {
      const cur = queue.shift();
      for (const dep of this.getDependents(cur, graph)) {
        if (!candidate.has(dep)) continue;
        if (distances.has(dep)) continue;
        distances.set(dep, (distances.get(cur) || 0) + 1);
        parent.set(dep, cur);
        queue.push(dep);
      }
    }

    let farthest = rootName;
    let bestDistance = -1;
    for (const [name, d] of distances.entries()) {
      if (d > bestDistance || (d === bestDistance && name.localeCompare(farthest) < 0)) {
        bestDistance = d;
        farthest = name;
      }
    }

    const chain = [farthest];
    let cursor = farthest;
    while (parent.has(cursor)) {
      cursor = parent.get(cursor);
      chain.push(cursor);
    }

    if (chain[chain.length - 1] !== rootName) chain.push(rootName);
    return chain;
  }

  detectFailureType(signal) {
    const text = [...(signal.events || []), ...(signal.logs || [])].join(' ').toLowerCase();

    if (text.includes('crashloopbackoff') || signal.status.includes('crash') || signal.status.includes('backoff')) {
      return 'CrashLoop';
    }
    if (text.includes('oomkilled') || text.includes('out of memory')) {
      return 'Memory';
    }
    if ((signal.metrics?.latency || 0) >= 1000) {
      return 'Latency';
    }
    if (
      text.includes('connection refused') ||
      text.includes('failed to connect') ||
      text.includes('timeout') ||
      text.includes('dial tcp')
    ) {
      return 'DependencyFailure';
    }

    return 'Unknown';
  }

  estimateSeverity(rootCause, affectedNodes) {
    const core = /db|database|redis|postgres|mysql|mongo|storage|auth/i.test(rootCause);
    if (core || affectedNodes.length >= 4) return 'CRITICAL';
    if (affectedNodes.length >= 2) return 'HIGH';
    if (affectedNodes.length === 1) return 'MEDIUM';
    return 'LOW';
  }

  calculateConfidence(signal, affectedCount, graph, rootName) {
    let score = 0.5;
    const text = [...(signal.events || []), ...(signal.logs || [])].join(' ').toLowerCase();

    if (signal.selfIssue) score += 0.15;
    if ((signal.metrics?.restartCount || 0) > 0) score += 0.05;
    if ((signal.metrics?.errorRate || 0) > (config.observer?.thresholds?.errorRate || 5)) score += 0.08;
    if (text.includes('error') || text.includes('failed') || text.includes('backoff') || text.includes('oom')) score += 0.12;
    if (affectedCount > 0) score += Math.min(0.1, affectedCount * 0.03);
    if (this.getDependents(rootName, graph).size > 0) score += 0.05;

    return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  }

  buildReasoning(rootCause, failureType, affectedNodes) {
    if (affectedNodes.length === 0) {
      return `${rootCause} has direct self-failure signals (${failureType}) with no downstream impacted nodes.`;
    }

    return `${rootCause} is a direct failure (${failureType}) and cascades to ${affectedNodes.join(', ')} via dependency graph relationships.`;
  }

  loadReport() {
    try {
      if (!fs.existsSync(this.reportPath)) {
        return { issues: [] };
      }

      const content = fs.readFileSync(this.reportPath, 'utf8');
      const parsed = JSON.parse(content);
      if (!parsed || !Array.isArray(parsed.issues)) return { issues: [] };
      return parsed;
    } catch (error) {
      logger.warn(`Failed to read RCA report: ${error.message}`);
      return { issues: [] };
    }
  }

  saveReport(report) {
    try {
      fs.writeFileSync(this.reportPath, JSON.stringify(report, null, 2), 'utf8');
    } catch (error) {
      logger.warn(`Failed to write RCA report: ${error.message}`);
    }
  }

  nextIssueId(report) {
    const ids = report.issues
      .map((i) => String(i.id || '').replace('issue-', ''))
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n));

    const next = ids.length ? Math.max(...ids) + 1 : 1;
    return `issue-${String(next).padStart(3, '0')}`;
  }

  updatePersistentReport(currentIssues, graph, nodeSignals) {
    const report = this.loadReport();
    const touched = [];
    let hasAppend = false;
    let hasUpdate = false;
    let hasResolve = false;

    const activeByRoot = new Map();
    for (const item of report.issues) {
      if (item.status === 'ACTIVE') activeByRoot.set(item.rootCause, item);
    }

    for (const issue of currentIssues) {
      const existing = activeByRoot.get(issue.rootCause);
      if (existing) {
        existing.timestamp = issue.timestamp;
        existing.confidence = issue.confidence;
        existing.severity = issue.severity;
        existing.failureType = issue.failureType;
        existing.failureChain = issue.failureChain;
        existing.affectedNodes = issue.affectedNodes;
        existing.dependencyDepth = issue.dependencyDepth;
        existing.reasoning = issue.reasoning;
        touched.push(existing);
        hasUpdate = true;
      } else {
        issue.id = this.nextIssueId(report);
        report.issues.push(issue);
        touched.push(issue);
        hasAppend = true;
      }
    }

    // Resolve stale active issues that are now fully healthy downstream.
    for (const item of report.issues) {
      if (item.status !== 'ACTIVE') continue;
      if (currentIssues.some((ci) => ci.rootCause === item.rootCause)) continue;

      const rootSignal = nodeSignals.get(item.rootCause);
      const rootHealthy = !rootSignal || rootSignal.selfIssue === false;
      const depsHealthy = this.areDependentsHealthy(item.rootCause, graph, nodeSignals);

      if (rootHealthy && depsHealthy) {
        item.status = 'RESOLVED';
        item.resolvedAt = new Date().toISOString();
        touched.push(item);
        hasResolve = true;
      }
    }

    this.saveReport(report);

    const action = hasAppend
      ? 'APPEND'
      : hasUpdate
      ? 'UPDATE'
      : hasResolve
      ? 'RESOLVE'
      : 'NO_ACTION';

    logger.info(`RCA report update: action=${action}, touchedIssues=${touched.length}, reportPath=${this.reportPath}`);

    return {
      action,
      issues: touched,
      reason: action === 'NO_ACTION' ? 'No issue lifecycle changes required' : 'RCA report updated',
    };
  }

  areDependentsHealthy(rootName, graph, nodeSignals) {
    const queue = [...Array.from(this.getDependents(rootName, graph))];
    const seen = new Set(queue);

    while (queue.length) {
      const current = queue.shift();
      const sig = nodeSignals.get(current);
      if (sig && (sig.selfIssue || sig.dependencyIssue)) {
        return false;
      }

      for (const next of this.getDependents(current, graph)) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }

    return true;
  }

  buildChainDetails(issue, nodeSignals) {
    const chain = Array.isArray(issue.failureChain) ? issue.failureChain : [];
    return chain.map((name, idx) => {
      const sig = nodeSignals.get(name);
      return {
        name,
        type: 'pod',
        depth: idx,
        health: {
          healthy: !(sig?.selfIssue || sig?.dependencyIssue),
          reason: sig?.selfIssue
            ? 'selfIssue=true'
            : sig?.dependencyIssue
            ? 'dependencyIssue=true'
            : 'healthy',
        },
      };
    });
  }

  exportGraph(graph) {
    const nodes = Array.from(graph.nodes).map((name) => ({ name }));
    const edges = [];

    for (const [from, deps] of graph.dependencies.entries()) {
      for (const to of deps) {
        edges.push({ from, to, type: 'dependency' });
      }
    }

    return { nodes, edges };
  }
}

module.exports = new RCAAgent();
