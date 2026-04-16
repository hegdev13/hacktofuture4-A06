/**
 * Root Cause Analysis Module - rca.js
 * Analyzes dependency graph to identify root causes of failures
 * 
 * Features:
 * - Identifies deepest failed node with healthy dependencies
 * - Confidence scoring based on multiple signals
 * - Failure path tracking with ordered chain
 * - Affected services analysis
 * - Recovery recommendations
 * - Multi-signal health assessment
 */

class RCAEngine {
  constructor(graph) {
    this.graph = graph;
    this.analysisLog = [];
  }

  /**
   * Perform root cause analysis on a failing node
   * @param {string} failingNode - Node that is failing
   * @returns {Object} - RCA result with root cause, path, confidence, etc.
   */
  analyzeFailure(failingNode) {
    const startTime = Date.now();
    const result = {
      startNode: failingNode,
      rootCause: null,
      failurePath: [],
      affectedServices: [],
      rootCauseConfidence: 0,
      signals: {},
      analysis: {},
    };

    // Get node info
    const nodeInfo = this.graph.getNodeInfo(failingNode);
    if (!nodeInfo) {
      result.analysis.error = `Node ${failingNode} not found`;
      return result;
    }

    // Get all transitive dependencies (potential root causes)
    const dependencies = this.graph.getTransitiveDependencies(failingNode);
    const failedDependencies = Array.from(dependencies).filter(
      depId => this.graph.nodes.get(depId)?.status === "FAILED"
    );

    // Find root cause (deepest failed node)
    if (failedDependencies.length > 0) {
      result.rootCause = this.findDeepestFailure(failingNode, failedDependencies);
      result.failurePath = this.buildFailurePath(failingNode, result.rootCause);
      result.rootCauseConfidence = this.calculateConfidence(result.rootCause, failingNode);
    } else {
      // Failing node is the root cause (no failed dependencies)
      result.rootCause = failingNode;
      result.failurePath = [failingNode];
      result.rootCauseConfidence = 0.95;
    }

    // Get affected services (all dependents of root cause)
    result.affectedServices = Array.from(
      this.graph.getTransitiveDependents(result.rootCause)
    );

    // Get detailed signals
    result.signals = this.analyzeFailureSignals(result.rootCause);

    // Build analysis summary
    result.analysis = {
      summary: this.buildAnalysisSummary(result),
      rootCauseType: this.classifyFailureType(result.rootCause),
      impact: this.assessImpact(result),
      recommendations: this.recommendActions(result),
    };

    // Log analysis
    this.logAnalysis(result, Date.now() - startTime);

    return result;
  }

  /**
   * Find the deepest node in failure chain that is FAILED
   * Uses a scoring algorithm to identify most likely root cause
   * @param {string} startNode - Starting failing node
   * @param {Array<string>} failedDependencies - All failed dependencies
   * @returns {string} - Node ID of root cause
   */
  findDeepestFailure(startNode, failedDependencies) {
    let rootCause = startNode;
    let maxScore = this.scoreFailureDepth(startNode);

    for (const dep of failedDependencies) {
      const score = this.scoreFailureDepth(dep);
      if (score > maxScore) {
        maxScore = score;
        rootCause = dep;
      }
    }

    return rootCause;
  }

  /**
   * Score how likely a node is to be the root cause
   * Factors:
   * - Depth (deeper = more likely to be root)
   * - Error rate (higher = more likely)
   * - Restart count (higher = more likely)
   * - Dependency count (more dependents = more likely)
   * @param {string} nodeId - Node to score
   * @returns {number}
   */
  scoreFailureDepth(nodeId) {
    const node = this.graph.nodes.get(nodeId);
    if (!node || node.status !== "FAILED") return -1;

    const nodeInfo = this.graph.getNodeInfo(nodeId);
    const depthScore = nodeInfo.dependencies.length; // Depth in tree
    const errorScore = node.errorRate * 100; // 0-100
    const restartScore = Math.min(node.restartCount * 10, 100); // 0-100+
    const dependentCount = nodeInfo.dependents.length;

    // Weighted scoring
    const score =
      depthScore * 1.0 +    // 1x weight for depth
      errorScore * 0.5 +    // 0.5x weight for error rate
      restartScore * 0.3 +  // 0.3x weight for restarts
      dependentCount * 0.2; // 0.2x weight for dependent count

    return score;
  }

  /**
   * Build ordered failure path from start node to root cause
   * @param {string} startNode - Failing service
   * @param {string} rootCause - Root cause node
   * @returns {Array<string>}
   */
  buildFailurePath(startNode, rootCause) {
    const path = [startNode];
    if (startNode === rootCause) {
      return path;
    }

    // BFS to find shortest path
    const queue = [[startNode]];
    const visited = new Set([startNode]);

    while (queue.length > 0) {
      const current = queue.shift();
      const lastNode = current[current.length - 1];

      if (lastNode === rootCause) {
        return current;
      }

      const deps = this.graph.getDependencies(lastNode) || [];
      for (const dep of deps) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push([...current, dep]);
        }
      }
    }

    // Fallback: just return [start, root]
    return [startNode, rootCause];
  }

  /**
   * Calculate confidence score for root cause identification
   * Factors:
   * - Is root cause FAILED? (high confidence)
   * - All its dependencies HEALTHY? (high confidence)
   * - Error rate / restart count
   * - Failure path clarity
   * @param {string} rootCause - Root cause node
   * @param {string} startNode - Original failing node
   * @returns {number} - 0-1 confidence score
   */
  calculateConfidence(rootCause, startNode) {
    const rootNode = this.graph.nodes.get(rootCause);
    const startNodeInfo = this.graph.getNodeInfo(startNode);

    if (!rootNode) return 0;

    let confidence = 0.5; // Base confidence

    // Factor 1: Is root actually FAILED?
    if (rootNode.status === "FAILED") {
      confidence += 0.3;
    }

    // Factor 2: Are ALL dependencies of root HEALTHY?
    const allDepsHealthy = this.graph.arAllDependenciesHealthy(rootCause);
    if (allDepsHealthy) {
      confidence += 0.15;
    }

    // Factor 3: Error rate indicates systemic issue
    if (rootNode.errorRate > 0.1) {
      confidence += 0.05;
    }

    // Factor 4: Restart count suggests repeated failures
    if (rootNode.restartCount > 2) {
      confidence += 0.05;
    }

    // Factor 5: Multiple dependents affected (strong signal)
    const dependents = this.graph.getTransitiveDependents(rootCause);
    if (dependents.size > 2) {
      confidence += 0.05;
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Analyze failure signals (error rates, restart counts, etc.)
   * @param {string} nodeId - Node to analyze
   * @returns {Object}
   */
  analyzeFailureSignals(nodeId) {
    const node = this.graph.nodes.get(nodeId);
    if (!node) return {};

    return {
      status: node.status,
      healthScore: node.healthScore,
      errorRate: node.errorRate,
      errorSeverity: node.errorRate > 0.5 ? "critical" : node.errorRate > 0.2 ? "high" : "medium",
      restartCount: node.restartCount,
      restartSeverity: node.restartCount > 5 ? "critical" : node.restartCount > 2 ? "high" : "low",
      lastStatusChange: node.lastStatusChange,
      timeSinceFail: Date.now() - node.lastStatusChange,
    };
  }

  /**
   * Classify type of failure (e.g., OOM, CrashLoop, Timeout, etc.)
   * @param {string} nodeId - Node to classify
   * @returns {string}
   */
  classifyFailureType(nodeId) {
    const signals = this.analyzeFailureSignals(nodeId);

    if (signals.restartCount > 5) {
      return "CrashLoop";
    }
    if (signals.errorRate > 0.5) {
      return "HighErrorRate";
    }
    const nodeInfo = this.graph.getNodeInfo(nodeId);
    if (nodeInfo && nodeInfo.dependencies.some(d => d.nodeStatus === "FAILED")) {
      return "DependencyFailure";
    }
    return "ServiceFailure";
  }

  /**
   * Assess impact of the failure
   * @param {Object} rcaResult - Result from analyzeFailure()
   * @returns {Object}
   */
  assessImpact(rcaResult) {
    const affectedCount = rcaResult.affectedServices.length;
    const totalNodes = this.graph.nodes.size;
    const impactPercent = Math.round((affectedCount / totalNodes) * 100);

    let severity = "low";
    if (impactPercent > 50) severity = "critical";
    else if (impactPercent > 25) severity = "high";
    else if (impactPercent > 10) severity = "medium";

    return {
      affectedServices: affectedCount,
      totalServices: totalNodes,
      impactPercent,
      severity,
    };
  }

  /**
   * Recommend remediation actions
   * @param {Object} rcaResult - Result from analyzeFailure()
   * @returns {Array<Object>}
   */
  recommendActions(rcaResult) {
    const recommendations = [];
    const failureType = rcaResult.analysis.rootCauseType;
    const rootCause = rcaResult.rootCause;
    const signals = rcaResult.signals;

    // Based on failure type
    switch (failureType) {
      case "CrashLoop":
        recommendations.push({
          priority: "CRITICAL",
          action: "Restart pod",
          command: `kubectl rollout restart deployment/${rootCause} -n default`,
          reason: "Pod is in crash loop (high restart count)",
          impact: "Service interruption (~30s)",
        });
        recommendations.push({
          priority: "HIGH",
          action: "Check logs",
          command: `kubectl logs -f ${rootCause} -n default --tail=100`,
          reason: "Diagnose crash cause",
          impact: "None (read-only)",
        });
        break;

      case "HighErrorRate":
        recommendations.push({
          priority: "HIGH",
          action: "Scale up replicas",
          command: `kubectl scale deployment ${rootCause} --replicas=3 -n default`,
          reason: "High error rate detected - increased load capacity",
          impact: "Temporary resource usage increase",
        });
        recommendations.push({
          priority: "MEDIUM",
          action: "Check for resource constraints",
          command: `kubectl describe node | grep -A5 "Allocated resources"`,
          reason: "Resource limitations may cause errors",
          impact: "None (read-only)",
        });
        break;

      case "DependencyFailure":
        recommendations.push({
          priority: "CRITICAL",
          action: "Heal dependency first",
          command: `kubectl get pods -n default | grep -E "${rcaResult.rootCause}"`,
          reason: "Service depends on failed dependency",
          impact: "Cascading recovery",
        });
        break;

      default:
        recommendations.push({
          priority: "MEDIUM",
          action: "Health check",
          command: `kubectl describe pod ${rootCause} -n default`,
          reason: "Investigate service health",
          impact: "None (read-only)",
        });
    }

    // Generic recommendations
    if (signals.timeSinceFail > 300000) {
      // 5 minutes+
      recommendations.push({
        priority: "HIGH",
        action: "Extended outage - escalate",
        command: `kubectl get events -n default | grep ${rootCause}`,
        reason: "Service has been down for extended period",
        impact: "None (read-only)",
      });
    }

    return recommendations;
  }

  /**
   * Build human-readable analysis summary
   * @param {Object} rcaResult - RCA result
   * @returns {string}
   */
  buildAnalysisSummary(rcaResult) {
    const { rootCause, failurePath, affectedServices, rootCauseConfidence } = rcaResult;
    const confidence = Math.round(rootCauseConfidence * 100);

    let summary = `ROOT CAUSE: ${rootCause} (${confidence}% confidence).\n`;
    summary += `FAILURE CHAIN: ${failurePath.join(" → ")}.\n`;
    summary += `AFFECTED SERVICES: ${affectedServices.length} downstream services impacted.`;

    return summary;
  }

  /**
   * Analyze all failed nodes in graph for comparison
   * @returns {Object}
   */
  analyzeAllFailures() {
    const failures = [];

    for (const [nodeId, node] of this.graph.nodes) {
      if (node.status === "FAILED") {
        failures.push(this.analyzeFailure(nodeId));
      }
    }

    // Sort by confidence descending
    failures.sort((a, b) => b.rootCauseConfidence - a.rootCauseConfidence);

    return {
      totalFailures: failures.length,
      results: failures,
      primaryRootCause: failures[0]?.rootCause || null,
    };
  }

  /**
   * Log analysis for debugging
   * @param {Object} result - Analysis result
   * @param {number} duration - Analysis duration in ms
   */
  logAnalysis(result, duration) {
    this.analysisLog.push({
      timestamp: new Date().toISOString(),
      startNode: result.startNode,
      rootCause: result.rootCause,
      confidence: result.rootCauseConfidence,
      durationMs: duration,
      affectedCount: result.affectedServices.length,
    });

    // Keep log size manageable
    if (this.analysisLog.length > 500) {
      this.analysisLog = this.analysisLog.slice(-250);
    }
  }

  /**
   * Get analysis history
   * @param {number} limit - Max entries to return
   * @returns {Array}
   */
  getAnalysisHistory(limit = 50) {
    return this.analysisLog.slice(-limit);
  }

  /**
   * Clear analysis log
   */
  clearAnalysisLog() {
    this.analysisLog = [];
  }
}

module.exports = RCAEngine;
