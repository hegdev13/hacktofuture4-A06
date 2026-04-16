/**
 * Root Cause Analysis Engine
 * Identifies root causes of service failures using graph traversal and heuristics
 */

const { HealthState } = require("./health");

class RCAEngine {
  constructor(graph, healthMonitor) {
    this.graph = graph;
    this.healthMonitor = healthMonitor;
    this.analyses = []; // History of analyses
  }

  /**
   * Find root cause of a failure
   * Returns: { rootCause, failurePath, affected, confidence, analysis }
   */
  analyzeFailure(failedNodeId) {
    const failedHealth = this.healthMonitor.getHealth(failedNodeId);

    if (failedHealth.state !== HealthState.FAILED) {
      throw new Error(`Node ${failedNodeId} is not in FAILED state`);
    }

    // Get all dependencies of the failed node
    const dependencies = this.graph.getTransitiveDependencies(failedNodeId);
    const failedDeps = dependencies.filter(
      (dep) =>
        this.healthMonitor.getHealth(dep).state === HealthState.FAILED
    );

    let rootCause = null;
    let failurePath = [];
    let confidence = 0;

    if (failedDeps.length === 0) {
      // Direct failure - no failed dependencies
      rootCause = failedNodeId;
      failurePath = [failedNodeId];
      confidence = 0.95;
    } else {
      // Find the deepest failed dependency (most likely root cause)
      const analysis = this.findDeepestFailure(failedNodeId, failedDeps);
      rootCause = analysis.deepestFailed;
      failurePath = analysis.path;
      confidence = analysis.confidence;
    }

    // Get affected services (all dependents of root cause)
    const affected = this.graph.getTransitiveDependents(rootCause);

    // Analyze failure signals
    const failureAnalysis = this.analyzeFailureSignals(rootCause);

    const result = {
      rootCause,
      failurePath,
      affected,
      confidence,
      analysis: {
        failureSignals: failureAnalysis,
        timestamp: new Date().toISOString(),
        failedDependencyCount: failedDeps.length,
      },
    };

    this.analyses.push(result);
    return result;
  }

  /**
   * Find the deepest failed node with highest error rate
   * Deeper = more likely to be root cause
   */
  findDeepestFailure(startNodeId, failedDeps) {
    let deepestFailed = startNodeId;
    let maxDepth = 0;
    let path = [];

    for (const failedDep of failedDeps) {
      const depPath = this.findPath(startNodeId, failedDep);
      const depth = depPath.length;

      const health = this.healthMonitor.getHealth(failedDep);
      const errorRate = health.signals.errorRate || 0.5;
      const score = depth + errorRate * 0.5; // Deeper + higher error rate

      if (score > maxDepth) {
        maxDepth = score;
        deepestFailed = failedDep;
        path = depPath;
      }
    }

    return {
      deepestFailed,
      path,
      confidence: Math.min(0.95, 0.5 + maxDepth * 0.1),
    };
  }

  /**
   * Find path between two nodes (BFS)
   */
  findPath(startId, endId) {
    if (startId === endId) return [startId];

    const queue = [[startId]];
    const visited = new Set([startId]);

    while (queue.length) {
      const path = queue.shift();
      const current = path[path.length - 1];

      for (const neighbor of this.graph.getDependencies(current)) {
        if (neighbor === endId) {
          return [...path, neighbor];
        }

        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push([...path, neighbor]);
        }
      }
    }

    return []; // No path found
  }

  /**
   * Analyze failure signals to determine cause
   */
  analyzeFailureSignals(nodeId) {
    const health = this.healthMonitor.getHealth(nodeId);
    const signals = health.signals;
    const reasons = [];

    if (signals.podStatus === "CrashLoopBackOff") {
      reasons.push("Pod is in CrashLoopBackOff - application crashes on startup");
    }
    if (signals.podStatus === "OOMKilled") {
      reasons.push("Pod killed due to Out of Memory - memory leak or insufficient limits");
    }
    if (signals.restartCount > 5) {
      reasons.push(`High restart count (${signals.restartCount}) - application instability`);
    }
    if (signals.errorRate > 0.5) {
      reasons.push(
        `High error rate (${(signals.errorRate * 100).toFixed(1)}%) - service malfunction`
      );
    }
    if (signals.responseTime > 5000) {
      reasons.push(`High latency (${signals.responseTime}ms) - performance degradation`);
    }
    if (signals.reason) {
      reasons.push(signals.reason);
    }

    return {
      signals,
      reasons,
      severity: health.score < 0.2 ? "CRITICAL" : health.score < 0.5 ? "HIGH" : "MEDIUM",
    };
  }

  /**
   * Get impact assessment of a failed service
   */
  getImpactAssessment(failedNodeId) {
    const directDependents = this.graph.getDependents(failedNodeId);
    const transitiveDependents = this.graph.getTransitiveDependents(failedNodeId);

    return {
      immediateImpact: directDependents,
      totalAffected: transitiveDependents,
      affectedCount: transitiveDependents.length,
      severity:
        transitiveDependents.length > 10
          ? "CRITICAL"
          : transitiveDependents.length > 5
          ? "HIGH"
          : "MEDIUM",
    };
  }

  /**
   * Suggest remediation steps based on root cause
   */
  suggestRemediation(failedNodeId) {
    const health = this.healthMonitor.getHealth(failedNodeId);
    const signals = health.signals;
    const remediation = [];

    if (signals.podStatus === "CrashLoopBackOff") {
      remediation.push({
        priority: 1,
        action: "Check logs for startup errors",
        command: `kubectl logs ${failedNodeId} --previous`,
      });
      remediation.push({
        priority: 2,
        action: "Restart pod",
        command: `kubectl delete pod ${failedNodeId}`,
      });
    }

    if (signals.podStatus === "OOMKilled") {
      remediation.push({
        priority: 1,
        action: "Increase memory limits",
        command: `kubectl set resources pod ${failedNodeId} --limits=memory=2Gi`,
      });
    }

    if (signals.restartCount > 5) {
      remediation.push({
        priority: 1,
        action: "Investigate restart cause",
        command: `kubectl describe pod ${failedNodeId}`,
      });
    }

    if (signals.errorRate > 0.5) {
      remediation.push({
        priority: 1,
        action: "Review application metrics and logs",
        command: `kubectl logs -f ${failedNodeId}`,
      });
    }

    if (remediation.length === 0) {
      remediation.push({
        priority: 1,
        action: "General diagnostic",
        command: `kubectl describe pod ${failedNodeId}`,
      });
    }

    return remediation;
  }

  /**
   * Analyze overall system health
   */
  analyzeSystemHealth() {
    const summary = this.healthMonitor.getSummary();
    const failedNodes = summary.failedNodes;

    const rootCauses = [];
    const affectedAll = new Set();

    for (const failedNode of failedNodes) {
      try {
        const analysis = this.analyzeFailure(failedNode);
        rootCauses.push({
          rootCause: analysis.rootCause,
          failedNode,
          confidence: analysis.confidence,
        });
        analysis.affected.forEach((a) => affectedAll.add(a));
      } catch (err) {
        console.error(`Failed to analyze ${failedNode}:`, err);
      }
    }

    // Deduplicate root causes
    const uniqueRootCauses = [
      ...new Map(rootCauses.map((r) => [r.rootCause, r])).values(),
    ];

    return {
      summary,
      rootCauses: uniqueRootCauses,
      totalAffected: affectedAll.size,
      systemHealth:
        summary.failed === 0
          ? "HEALTHY"
          : summary.degraded === 0
          ? "CRITICAL"
          : "DEGRADED",
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get analysis history
   */
  getHistory() {
    return this.analyses;
  }
}

module.exports = RCAEngine;
