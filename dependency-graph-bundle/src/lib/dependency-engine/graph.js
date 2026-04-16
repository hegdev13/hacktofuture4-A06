/**
 * Directed Graph Implementation for Service Dependencies
 * Nodes = Services/Pods, Edges = Dependencies (A→B means A depends on B)
 */

class DependencyGraph {
  constructor() {
    this.nodes = new Map(); // node_id → { id, name, metadata }
    this.adjacencyList = new Map(); // node_id → Set of dependent node_ids
    this.reverseAdjacency = new Map(); // node_id → Set of nodes that depend on it
    this.edges = new Set(); // edges as "source→target"
  }

  /**
   * Add a node to the graph
   */
  addNode(id, name, metadata = {}) {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, name, metadata });
      this.adjacencyList.set(id, new Set());
      this.reverseAdjacency.set(id, new Set());
    }
  }

  /**
   * Add a directed edge: sourceId depends on targetId
   * Returns true if edge added, false if it would create a cycle
   */
  addEdge(sourceId, targetId, metadata = {}) {
    // Don't add self-loops
    if (sourceId === targetId) return false;

    // Check if edge already exists
    const edgeKey = `${sourceId}→${targetId}`;
    if (this.edges.has(edgeKey)) return false;

    // Check for cycles (would adding this edge create a cycle?)
    if (this.wouldCreateCycle(sourceId, targetId)) {
      console.warn(`⚠ Cycle detected: ${sourceId} → ${targetId}. Edge rejected.`);
      return false;
    }

    // Ensure both nodes exist
    if (!this.nodes.has(sourceId)) this.addNode(sourceId, sourceId);
    if (!this.nodes.has(targetId)) this.addNode(targetId, targetId);

    // Add edge
    this.adjacencyList.get(sourceId).add(targetId);
    this.reverseAdjacency.get(targetId).add(sourceId);
    this.edges.add(edgeKey);

    return true;
  }

  /**
   * Check if adding an edge would create a cycle using DFS
   */
  wouldCreateCycle(sourceId, targetId) {
    // If targetId can reach sourceId, adding sourceId→targetId creates a cycle
    const visited = new Set();
    return this.canReach(targetId, sourceId, visited);
  }

  /**
   * Check if startId can reach endId
   */
  canReach(startId, endId, visited = new Set()) {
    if (startId === endId) return true;
    if (visited.has(startId)) return false;
    visited.add(startId);

    const deps = this.adjacencyList.get(startId) || new Set();
    for (const dep of deps) {
      if (this.canReach(dep, endId, visited)) return true;
    }
    return false;
  }

  /**
   * Get all nodes that depend on a given node (direct dependents)
   */
  getDependents(nodeId) {
    return Array.from(this.reverseAdjacency.get(nodeId) || []);
  }

  /**
   * Get all nodes this node depends on (direct dependencies)
   */
  getDependencies(nodeId) {
    return Array.from(this.adjacencyList.get(nodeId) || []);
  }

  /**
   * Get all transitive dependencies (recursive) - all services this depends on
   */
  getTransitiveDependencies(nodeId, visited = new Set()) {
    if (visited.has(nodeId)) return [];
    visited.add(nodeId);

    const result = [];
    const directDeps = this.getDependencies(nodeId);

    for (const dep of directDeps) {
      result.push(dep);
      result.push(...this.getTransitiveDependencies(dep, visited));
    }

    return [...new Set(result)]; // Deduplicate
  }

  /**
   * Get all transitive dependents (recursive) - all services that depend on this
   */
  getTransitiveDependents(nodeId, visited = new Set()) {
    if (visited.has(nodeId)) return [];
    visited.add(nodeId);

    const result = [];
    const directDependents = this.getDependents(nodeId);

    for (const dependent of directDependents) {
      result.push(dependent);
      result.push(...this.getTransitiveDependents(dependent, visited));
    }

    return [...new Set(result)]; // Deduplicate
  }

  /**
   * Remove a node and all its edges
   */
  removeNode(nodeId) {
    if (!this.nodes.has(nodeId)) return;

    // Remove edges
    const deps = this.adjacencyList.get(nodeId) || new Set();
    const dependents = this.reverseAdjacency.get(nodeId) || new Set();

    deps.forEach((dep) => {
      this.edges.delete(`${nodeId}→${dep}`);
      this.reverseAdjacency.get(dep)?.delete(nodeId);
    });

    dependents.forEach((dependent) => {
      this.edges.delete(`${dependent}→${nodeId}`);
      this.adjacencyList.get(dependent)?.delete(nodeId);
    });

    // Remove node
    this.nodes.delete(nodeId);
    this.adjacencyList.delete(nodeId);
    this.reverseAdjacency.delete(nodeId);
  }

  /**
   * Get graph statistics
   */
  getStats() {
    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      nodes: Array.from(this.nodes.keys()),
      edges: Array.from(this.edges),
    };
  }

  /**
   * Export graph as adjacency list for visualization
   */
  export() {
    const result = {};
    for (const [nodeId, deps] of this.adjacencyList.entries()) {
      result[nodeId] = {
        name: this.nodes.get(nodeId)?.name || nodeId,
        dependsOn: Array.from(deps),
        dependents: Array.from(this.reverseAdjacency.get(nodeId) || []),
      };
    }
    return result;
  }
}

module.exports = DependencyGraph;
