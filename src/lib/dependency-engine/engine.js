/**
 * Dependency Graph Engine - Main Orchestrator
 * Coordinates graph, health, RCA, and extraction
 */

const DependencyGraph = require("./graph");
const { HealthMonitor, HealthState } = require("./health");
const RCAEngine = require("./rca");
const DependencyExtractor = require("./dependency-extractor");

class DependencyGraphEngine {
  constructor() {
    this.graph = new DependencyGraph();
    this.healthMonitor = new HealthMonitor();
    this.rcaEngine = new RCAEngine(this.graph, this.healthMonitor);
    this.events = []; // Event log for tracking changes
  }

  /**
   * Initialize engine with pods and automatic dependency extraction
   */
  initializePods(pods) {
    // Add nodes
    for (const pod of pods) {
      const id = pod.id || pod.name;
      this.graph.addNode(id, pod.name || id, { pod });
      this.healthMonitor.updateHealth(id, {
        podStatus: pod.status || "Unknown",
        restartCount: pod.restartCount || 0,
        errorRate: 0,
      });
    }

    // Extract and build dependencies
    DependencyExtractor.buildGraphFromPods(pods, this.graph);

    this.logEvent("pods_initialized", { count: pods.length });
    return this.getStatus();
  }

  /**
   * Add a pod dynamically
   */
  addPod(pod) {
    const id = pod.id || pod.name;
    this.graph.addNode(id, pod.name || id, { pod });
    this.healthMonitor.updateHealth(id, {
      podStatus: pod.status || "Running",
      restartCount: pod.restartCount || 0,
      errorRate: 0,
    });

    // Extract dependencies
    const deps = DependencyExtractor.extractAll(pod).merged;
    for (const dep of deps) {
      this.graph.addEdge(id, dep);
    }

    this.logEvent("pod_added", { podId: id, podName: pod.name });
    return id;
  }

  /**
   * Remove a pod
   */
  removePod(podId) {
    this.graph.removeNode(podId);
    this.logEvent("pod_removed", { podId });
  }

  /**
   * Update pod health from metrics
   */
  updatePodHealth(podId, signals) {
    this.healthMonitor.updateHealth(podId, signals);
    this.healthMonitor.propagateHealth(podId, this.graph);

    const health = this.healthMonitor.getHealth(podId);

    this.logEvent("health_updated", {
      podId,
      state: health.state,
      score: health.score,
    });

    return health;
  }

  /**
   * Report a pod failure
   */
  reportFailure(podId, reason = "") {
    this.healthMonitor.markFailed(podId, reason);
    this.healthMonitor.propagateHealth(podId, this.graph);

    const analysis = this.rcaEngine.analyzeFailure(podId);
    const impact = this.rcaEngine.getImpactAssessment(podId);
    const remediation = this.rcaEngine.suggestRemediation(podId);

    const event = {
      type: "failure_detected",
      podId,
      analysis,
      impact,
      remediation,
      timestamp: new Date().toISOString(),
    };

    this.logEvent("failure_detected", event);

    return {
      success: true,
      analysis,
      impact,
      remediation,
    };
  }

  /**
   * Report a pod recovery/healing
   */
  reportHealing(podId) {
    this.healthMonitor.markHealthy(podId);
    this.healthMonitor.propagateHealth(podId, this.graph);

    // Get list of services that were affected and are now recovering
    const dependents = this.graph.getTransitiveDependents(podId);
    const recovered = [];

    for (const dependent of dependents) {
      const health = this.healthMonitor.getHealth(dependent);
      if (health.state === HealthState.HEALTHY && health.recovered === true) {
        recovered.push(dependent);
      }
    }

    const event = {
      type: "pod_recovered",
      podId,
      recovered,
      timestamp: new Date().toISOString(),
    };

    this.logEvent("pod_recovered", event);

    return {
      success: true,
      recovered,
      systemHealth: this.rcaEngine.analyzeSystemHealth(),
    };
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      graph: {
        nodes: this.graph.getStats().nodeCount,
        edges: this.graph.getStats().edgeCount,
      },
      health: this.healthMonitor.getSummary(),
      systemHealth: this.rcaEngine.analyzeSystemHealth(),
    };
  }

  /**
   * Get detailed analysis of a specific pod
   */
  analyzePod(podId) {
    const health = this.healthMonitor.getHealth(podId);
    const dependencies = this.graph.getDependencies(podId);
    const dependents = this.graph.getDependents(podId);
    const transitiveDeps = this.graph.getTransitiveDependencies(podId);
    const transitiveDependents = this.graph.getTransitiveDependents(podId);

    let analysis = null;
    let remediation = null;

    if (health.state === HealthState.FAILED) {
      analysis = this.rcaEngine.analyzeFailure(podId);
      remediation = this.rcaEngine.suggestRemediation(podId);
    }

    return {
      podId,
      health,
      dependencies: {
        direct: dependencies,
        transitive: transitiveDeps,
      },
      dependents: {
        direct: dependents,
        transitive: transitiveDependents,
      },
      analysis,
      remediation,
    };
  }

  /**
   * Get dependency visualization data
   */
  exportGraph() {
    return this.graph.export();
  }

  /**
   * Get event log
   */
  getEventLog() {
    return this.events;
  }

  /**
   * Internal: Log event
   */
  logEvent(type, data) {
    this.events.push({
      type,
      data,
      timestamp: new Date().toISOString(),
    });

    // Keep only last 1000 events
    if (this.events.length > 1000) {
      this.events = this.events.slice(-1000);
    }
  }
}

module.exports = DependencyGraphEngine;
