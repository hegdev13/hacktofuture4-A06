/**
 * Health Monitoring and State Management
 * Evaluates service health based on multiple signals
 */

const HealthState = {
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  FAILED: "FAILED",
};

class HealthMonitor {
  constructor() {
    this.healthMap = new Map(); // nodeId → { state, score, signals, lastUpdate }
    this.thresholds = {
      degraded: 0.5, // Below 50% → degraded
      failed: 0.2, // Below 20% → failed
    };
  }

  /**
   * Compute health score (0-1) based on multiple signals
   * Signals: { restartCount, errorRate, podStatus, responseTime, cpuUsage, memoryUsage }
   */
  computeHealthScore(signals = {}) {
    let score = 1.0;
    const weights = {
      restartCount: 0.3,
      errorRate: 0.3,
      podStatus: 0.2,
      responseTime: 0.1,
      resourceUsage: 0.1,
    };

    // Restart count penalty (more restarts = lower score)
    if (signals.restartCount != null) {
      const restartPenalty = Math.min(signals.restartCount * 0.1, 1.0);
      score -= restartPenalty * weights.restartCount;
    }

    // Error rate penalty
    if (signals.errorRate != null) {
      score -= signals.errorRate * weights.errorRate; // errorRate is 0-1
    }

    // Pod status penalty
    if (signals.podStatus) {
      const statusPenalties = {
        Running: 0,
        CrashLoopBackOff: 1.0,
        OOMKilled: 1.0,
        ImagePullBackOff: 0.8,
        Pending: 0.5,
        Unknown: 0.7,
      };
      const penalty = statusPenalties[signals.podStatus] || 0.5;
      score -= penalty * weights.podStatus;
    }

    // Response time penalty (latency)
    if (signals.responseTime != null) {
      // Response time in ms: < 100ms = 0 penalty, > 5000ms = full penalty
      const latencyPenalty = Math.min(signals.responseTime / 5000, 1.0);
      score -= latencyPenalty * weights.responseTime;
    }

    // Resource usage penalty (high CPU/Memory)
    if (signals.cpuUsage != null || signals.memoryUsage != null) {
      let resourcePenalty = 0;
      if (signals.cpuUsage != null && signals.cpuUsage > 0.9) resourcePenalty += 0.5;
      if (signals.memoryUsage != null && signals.memoryUsage > 0.9) resourcePenalty += 0.5;
      score -= resourcePenalty * weights.resourceUsage;
    }

    return Math.max(0, Math.min(score, 1.0));
  }

  /**
   * Determine health state from score
   */
  getState(score) {
    if (score >= this.thresholds.degraded) return HealthState.HEALTHY;
    if (score >= this.thresholds.failed) return HealthState.DEGRADED;
    return HealthState.FAILED;
  }

  /**
   * Update health for a node
   */
  updateHealth(nodeId, signals = {}) {
    const score = this.computeHealthScore(signals);
    const state = this.getState(score);

    this.healthMap.set(nodeId, {
      state,
      score,
      signals: { ...signals },
      lastUpdate: new Date().toISOString(),
      confidence: 0.9, // Health assessment confidence
    });

    return { state, score };
  }

  /**
   * Get health for a node
   */
  getHealth(nodeId) {
    return (
      this.healthMap.get(nodeId) || {
        state: HealthState.HEALTHY,
        score: 1.0,
        signals: {},
        lastUpdate: null,
      }
    );
  }

  /**
   * Get all nodes in a specific state
   */
  getNodesByState(state) {
    const result = [];
    for (const [nodeId, health] of this.healthMap.entries()) {
      if (health.state === state) {
        result.push({ nodeId, ...health });
      }
    }
    return result;
  }

  /**
   * Mark node as failed
   */
  markFailed(nodeId, reason = "") {
    this.healthMap.set(nodeId, {
      state: HealthState.FAILED,
      score: 0,
      signals: { reason },
      lastUpdate: new Date().toISOString(),
      confidence: 1.0,
    });
  }

  /**
   * Mark node as recovered/healthy
   */
  markHealthy(nodeId) {
    this.healthMap.set(nodeId, {
      state: HealthState.HEALTHY,
      score: 1.0,
      signals: {},
      lastUpdate: new Date().toISOString(),
      confidence: 0.95,
    });
  }

  /**
   * Propagate health changes through dependency chains
   * If a dependency fails, mark dependents as DEGRADED
   */
  propagateHealth(nodeId, graph) {
    const health = this.getHealth(nodeId);

    if (health.state === HealthState.FAILED) {
      // Mark all dependents as DEGRADED
      const dependents = graph.getTransitiveDependents(nodeId);
      for (const dependent of dependents) {
        const depHealth = this.getHealth(dependent);
        if (
          depHealth.state === HealthState.HEALTHY ||
          (depHealth.state === HealthState.DEGRADED &&
            depHealth.dependencyFailure !== true)
        ) {
          this.healthMap.set(dependent, {
            ...depHealth,
            state: HealthState.DEGRADED,
            dependencyFailure: true,
            failureSource: nodeId,
          });
        }
      }
    } else if (health.state === HealthState.HEALTHY) {
      // Try to restore dependents if no other failures exist
      const dependents = graph.getTransitiveDependents(nodeId);
      for (const dependent of dependents) {
        const depHealth = this.getHealth(dependent);
        if (
          depHealth.state === HealthState.DEGRADED &&
          depHealth.failureSource === nodeId
        ) {
          // Check if dependent has direct failures
          const deps = graph.getDependencies(dependent);
          const hasOtherFailures = deps.some(
            (dep) => this.getHealth(dep).state === HealthState.FAILED
          );

          if (!hasOtherFailures) {
            this.healthMap.set(dependent, {
              state: HealthState.HEALTHY,
              score: 1.0,
              signals: {},
              lastUpdate: new Date().toISOString(),
              recovered: true,
            });
          }
        }
      }
    }
  }

  /**
   * Get health summary
   */
  getSummary() {
    const summary = {
      total: this.healthMap.size,
      healthy: 0,
      degraded: 0,
      failed: 0,
      healthyNodes: [],
      degradedNodes: [],
      failedNodes: [],
    };

    for (const [nodeId, health] of this.healthMap.entries()) {
      if (health.state === HealthState.HEALTHY) {
        summary.healthy++;
        summary.healthyNodes.push(nodeId);
      } else if (health.state === HealthState.DEGRADED) {
        summary.degraded++;
        summary.degradedNodes.push(nodeId);
      } else {
        summary.failed++;
        summary.failedNodes.push(nodeId);
      }
    }

    return summary;
  }
}

module.exports = { HealthMonitor, HealthState };
