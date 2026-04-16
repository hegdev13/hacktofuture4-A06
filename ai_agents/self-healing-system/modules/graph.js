/**
 * Dependency Graph Module - graph.js
 * Manages service dependency graph with failure propagation and recovery
 * 
 * Features:
 * - Directed graph with dependency types (hard/soft)
 * - Failure propagation with cycle prevention
 * - Health state tracking and updates
 * - Dynamic node/edge management
 * - Debug logging for propagation steps
 */

class DependencyGraph {
  constructor() {
    this.nodes = new Map();           // nodeId → { status, healthScore, errorRate, restartCount }
    this.edges = new Map();           // nodeId → [{ node, type, weight }]
    this.reverseEdges = new Map();    // nodeId → [{ node, type, weight }] (dependents)
    this.propagationLog = [];         // Debug: track all propagation steps
    this.visitedInCycle = new Set();  // Prevent infinite loops during propagation
  }

  /**
   * Add a node to the graph
   * @param {string} nodeId - Unique node identifier
   * @param {Object} initialState - { status, healthScore, errorRate, restartCount }
   */
  addNode(nodeId, initialState = {}) {
    if (this.nodes.has(nodeId)) {
      console.warn(`Node ${nodeId} already exists`);
      return;
    }

    this.nodes.set(nodeId, {
      status: initialState.status || "HEALTHY",
      healthScore: initialState.healthScore ?? 1.0,
      errorRate: initialState.errorRate ?? 0,
      restartCount: initialState.restartCount ?? 0,
      lastStatusChange: Date.now(),
    });

    // Initialize adjacency lists
    if (!this.edges.has(nodeId)) {
      this.edges.set(nodeId, []);
    }
    if (!this.reverseEdges.has(nodeId)) {
      this.reverseEdges.set(nodeId, []);
    }

    this.logPropagation(`ADD_NODE: ${nodeId}`, {
      status: this.nodes.get(nodeId).status,
      healthScore: this.nodes.get(nodeId).healthScore,
    });
  }

  /**
   * Add a directed edge: from → to
   * @param {string} from - Source node
   * @param {string} to - Dependency node
   * @param {string} type - "hard" or "soft"
   * @param {number} weight - Optional weight (0-1, default 1.0)
   */
  addEdge(from, to, type = "hard", weight = 1.0) {
    if (!this.nodes.has(from)) {
      throw new Error(`Source node ${from} does not exist`);
    }
    if (!this.nodes.has(to)) {
      throw new Error(`Target node ${to} does not exist`);
    }

    if (!["hard", "soft"].includes(type)) {
      throw new Error(`Invalid edge type: ${type}. Must be "hard" or "soft"`);
    }

    // Check if edge already exists
    const existingEdge = this.edges.get(from).find(e => e.node === to);
    if (existingEdge) {
      console.warn(`Edge ${from} → ${to} already exists`);
      return;
    }

    // Add forward edge
    this.edges.get(from).push({ node: to, type, weight });

    // Add reverse edge (for dependents)
    this.reverseEdges.get(to).push({ node: from, type, weight });

    this.logPropagation(`ADD_EDGE: ${from} → ${to} (type: ${type}, weight: ${weight})`);
  }

  /**
   * Update node health (simulates metrics update)
   * @param {string} nodeId - Node to update
   * @param {Object} metrics - { status, healthScore, errorRate, restartCount }
   */
  updateHealth(nodeId, metrics) {
    if (!this.nodes.has(nodeId)) {
      throw new Error(`Node ${nodeId} does not exist`);
    }

    const node = this.nodes.get(nodeId);
    const oldStatus = node.status;

    // Update metrics
    if (metrics.status !== undefined) node.status = metrics.status;
    if (metrics.healthScore !== undefined) node.healthScore = metrics.healthScore;
    if (metrics.errorRate !== undefined) node.errorRate = metrics.errorRate;
    if (metrics.restartCount !== undefined) node.restartCount = metrics.restartCount;

    node.lastStatusChange = Date.now();

    this.logPropagation(`UPDATE_HEALTH: ${nodeId}`, {
      oldStatus,
      newStatus: node.status,
      healthScore: node.healthScore,
      errorRate: node.errorRate,
    });

    // Clear cycle detection from previous propagation
    this.visitedInCycle.clear();

    // Propagate failure/recovery
    if (node.status === "FAILED") {
      this.propagateFailure(nodeId);
    } else if (node.status === "HEALTHY") {
      this.propagateRecovery(nodeId);
    }
  }

  /**
   * Propagate failure to dependents (nodes that depend on this one)
   * @param {string} nodeId - Failed node
   */
  propagateFailure(nodeId) {
    const node = this.nodes.get(nodeId);

    this.logPropagation(`PROPAGATE_FAILURE_START: ${nodeId}`, {
      status: node.status,
      dependentCount: this.reverseEdges.get(nodeId).length,
    });

    // Traverse reverse edges (dependents)
    const dependents = this.reverseEdges.get(nodeId) || [];

    for (const dependent of dependents) {
      const dependentNode = this.nodes.get(dependent.node);
      if (!dependentNode) continue;

      // Apply propagation rule based on edge type
      if (dependent.type === "hard") {
        // Hard dependency: if it fails, dependent MUST fail
        if (dependentNode.status !== "FAILED") {
          this.logPropagation(`HARD_DEPENDENCY_FAILURE: ${nodeId} → ${dependent.node}`);
          dependentNode.status = "FAILED";
          dependentNode.healthScore = Math.max(0, dependentNode.healthScore - 0.5);
          dependentNode.lastStatusChange = Date.now();

          // Recursively propagate
          this.propagateFailure(dependent.node);
        }
      } else if (dependent.type === "soft") {
        // Soft dependency: if it fails, dependent becomes degraded
        if (dependentNode.status === "HEALTHY") {
          this.logPropagation(`SOFT_DEPENDENCY_DEGRADATION: ${nodeId} → ${dependent.node}`);
          dependentNode.status = "DEGRADED";
          dependentNode.healthScore = Math.max(0, dependentNode.healthScore - 0.25);
          dependentNode.lastStatusChange = Date.now();

          // Continue propagation (soft only degrades next level)
          this.propagateFailure(dependent.node);
        }
      }
    }

    this.logPropagation(`PROPAGATE_FAILURE_END: ${nodeId}`);
  }

  /**
   * Propagate recovery from a healthy node
   * @param {string} nodeId - Recovered node
   */
  propagateRecovery(nodeId) {
    const node = this.nodes.get(nodeId);

    this.logPropagation(`PROPAGATE_RECOVERY_START: ${nodeId}`, {
      status: node.status,
      dependentCount: this.reverseEdges.get(nodeId).length,
    });

    // Check all dependents - if ALL their dependencies are healthy, restore them
    const dependents = this.reverseEdges.get(nodeId) || [];

    for (const dependent of dependents) {
      const dependentNode = this.nodes.get(dependent.node);
      if (!dependentNode) continue;

      // Skip if already healthy
      if (dependentNode.status === "HEALTHY") continue;

      // Check if all dependencies of dependent are healthy
      const allDependenciesHealthy = this.arAllDependenciesHealthy(dependent.node);

      if (allDependenciesHealthy) {
        this.logPropagation(`RECOVERY_PROPAGATED: ${dependent.node} restored to HEALTHY`);
        dependentNode.status = "HEALTHY";
        dependentNode.healthScore = 1.0;
        dependentNode.lastStatusChange = Date.now();

        // Recursively propagate recovery
        this.propagateRecovery(dependent.node);
      } else {
        // If not all dependencies are healthy, mark as degraded (not failed)
        if (dependentNode.status === "FAILED") {
          this.logPropagation(`PARTIAL_RECOVERY: ${dependent.node} downgraded to DEGRADED`);
          dependentNode.status = "DEGRADED";
          dependentNode.healthScore = 0.5;
          dependentNode.lastStatusChange = Date.now();
        }
      }
    }

    this.logPropagation(`PROPAGATE_RECOVERY_END: ${nodeId}`);
  }

  /**
   * Check if all dependencies of a node are healthy
   * @param {string} nodeId - Node to check
   * @returns {boolean}
   */
  arAllDependenciesHealthy(nodeId) {
    const dependencies = this.edges.get(nodeId) || [];

    for (const dep of dependencies) {
      const depNode = this.nodes.get(dep.node);
      if (!depNode || depNode.status !== "HEALTHY") {
        return false;
      }
    }

    return true;
  }

  /**
   * Get all nodes that depend on a given node
   * @param {string} nodeId - Node to find dependents for
   * @returns {Array<string>}
   */
  getDependents(nodeId) {
    return (this.reverseEdges.get(nodeId) || []).map(e => e.node);
  }

  /**
   * Get all dependencies of a node
   * @param {string} nodeId - Node to find dependencies for
   * @returns {Array<string>}
   */
  getDependencies(nodeId) {
    return (this.edges.get(nodeId) || []).map(e => e.node);
  }

  /**
   * Get all transitive dependencies (full chain)
   * @param {string} nodeId - Starting node
   * @returns {Set<string>}
   */
  getTransitiveDependencies(nodeId) {
    const visited = new Set();
    const stack = [nodeId];

    while (stack.length > 0) {
      const current = stack.pop();
      if (visited.has(current)) continue;

      visited.add(current);
      const deps = this.getDependencies(current);
      stack.push(...deps.filter(d => !visited.has(d)));
    }

    visited.delete(nodeId); // Don't include self
    return visited;
  }

  /**
   * Get all transitive dependents (full chain downstream)
   * @param {string} nodeId - Starting node
   * @returns {Set<string>}
   */
  getTransitiveDependents(nodeId) {
    const visited = new Set();
    const stack = [nodeId];

    while (stack.length > 0) {
      const current = stack.pop();
      if (visited.has(current)) continue;

      visited.add(current);
      const deps = this.getDependents(current);
      stack.push(...deps.filter(d => !visited.has(d)));
    }

    visited.delete(nodeId); // Don't include self
    return visited;
  }

  /**
   * Get complete graph state
   * @returns {Object}
   */
  getState() {
    const state = {
      nodes: {},
      edges: {},
    };

    // Nodes
    for (const [nodeId, node] of this.nodes) {
      state.nodes[nodeId] = {
        status: node.status,
        healthScore: node.healthScore,
        errorRate: node.errorRate,
        restartCount: node.restartCount,
      };
    }

    // Edges
    for (const [from, edges] of this.edges) {
      state.edges[from] = edges.map(e => ({
        to: e.node,
        type: e.type,
        weight: e.weight,
      }));
    }

    return state;
  }

  /**
   * Detect cycles in the graph using DFS
   * @returns {Array<Array<string>> | null} - Returns first cycle found, or null
   */
  detectCycles() {
    const visited = new Set();
    const recursionStack = new Set();
    const cycles = [];

    const dfs = (node, path) => {
      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const deps = this.getDependencies(node);
      for (const dep of deps) {
        if (!visited.has(dep)) {
          dfs(dep, [...path]);
        } else if (recursionStack.has(dep)) {
          // Found a cycle
          const cycleStart = path.indexOf(dep);
          const cycle = path.slice(cycleStart).concat([dep]);
          cycles.push(cycle);
        }
      }

      recursionStack.delete(node);
    };

    for (const nodeId of this.nodes.keys()) {
      if (!visited.has(nodeId)) {
        dfs(nodeId, []);
      }
    }

    return cycles.length > 0 ? cycles : null;
  }

  /**
   * Get detailed node information including related deps
   * @param {string} nodeId - Node to inspect
   * @returns {Object}
   */
  getNodeInfo(nodeId) {
    if (!this.nodes.has(nodeId)) {
      return null;
    }

    const node = this.nodes.get(nodeId);
    const dependencies = this.edges.get(nodeId) || [];
    const dependents = this.reverseEdges.get(nodeId) || [];

    return {
      id: nodeId,
      status: node.status,
      healthScore: node.healthScore,
      errorRate: node.errorRate,
      restartCount: node.restartCount,
      lastStatusChange: node.lastStatusChange,
      dependencies: dependencies.map(d => ({
        node: d.node,
        type: d.type,
        weight: d.weight,
        nodeStatus: this.nodes.get(d.node)?.status || "UNKNOWN",
      })),
      dependents: dependents.map(d => ({
        node: d.node,
        type: d.type,
        weight: d.weight,
        nodeStatus: this.nodes.get(d.node)?.status || "UNKNOWN",
      })),
    };
  }

  /**
   * Log propagation step for debugging
   * @param {string} action - Action name
   * @param {Object} details - Action details
   */
  logPropagation(action, details = {}) {
    const timestamp = new Date().toISOString();
    this.propagationLog.push({
      timestamp,
      action,
      details,
    });

    // Keep log size manageable
    if (this.propagationLog.length > 1000) {
      this.propagationLog = this.propagationLog.slice(-500);
    }
  }

  /**
   * Get propagation log for debugging
   * @param {number} limit - Max entries to return
   * @returns {Array}
   */
  getPropagationLog(limit = 100) {
    return this.propagationLog.slice(-limit);
  }

  /**
   * Clear propagation log
   */
  clearPropagationLog() {
    this.propagationLog = [];
  }

  /**
   * Get system health summary
   * @returns {Object}
   */
  getHealthSummary() {
    let healthy = 0;
    let degraded = 0;
    let failed = 0;
    let totalHealth = 0;

    for (const node of this.nodes.values()) {
      if (node.status === "HEALTHY") healthy++;
      else if (node.status === "DEGRADED") degraded++;
      else if (node.status === "FAILED") failed++;

      totalHealth += node.healthScore;
    }

    const total = this.nodes.size;
    const averageHealth = total > 0 ? totalHealth / total : 1.0;

    return {
      total,
      healthy,
      degraded,
      failed,
      healthPercent: Math.round(averageHealth * 100),
      averageHealth,
    };
  }
}

module.exports = DependencyGraph;
