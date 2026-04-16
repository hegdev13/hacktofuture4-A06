/**
 * Dependency Graph Module - Pure State Propagation
 * Manages service dependencies and state propagation ONLY
 * Does NOT perform root cause analysis
 * 
 * Focus: Structure + State Propagation + Recovery Logic
 */

class DependencyGraph {
  constructor() {
    // Adjacency list: service → [{ node, type }]
    this.graph = new Map();
    
    // Node state: service → { status, restartCount, errorRate }
    this.nodeState = new Map();
    
    // Reverse edges (dependents): service → [{ node, type }]
    this.dependents = new Map();
    
    // Visited tracking for cycle prevention
    this.visited = new Set();
    this.recursionStack = new Set();
  }

  /**
   * Add a service node to the graph
   * @param {string} service - Service name
   * @param {Object} state - Initial state { status, restartCount, errorRate }
   */
  addNode(service, state = {}) {
    if (this.graph.has(service)) {
      console.warn(`Service ${service} already exists`);
      return;
    }

    this.graph.set(service, []);
    this.dependents.set(service, []);
    
    this.nodeState.set(service, {
      status: state.status || 'HEALTHY',
      restartCount: state.restartCount || 0,
      errorRate: state.errorRate || 0,
    });

    console.log(`✓ Added node: ${service}`);
  }

  /**
   * Add a directed edge: serviceA depends on serviceB
   * @param {string} serviceA - Dependent service
   * @param {string} serviceB - Dependency service
   * @param {string} type - "hard" or "soft"
   */
  addEdge(serviceA, serviceB, type = 'hard') {
    if (!this.graph.has(serviceA)) {
      throw new Error(`Service ${serviceA} not found`);
    }
    if (!this.graph.has(serviceB)) {
      throw new Error(`Service ${serviceB} not found`);
    }

    if (!['hard', 'soft'].includes(type)) {
      throw new Error(`Invalid edge type: ${type}. Must be "hard" or "soft"`);
    }

    // Check for duplicate
    const exists = this.graph.get(serviceA).some(e => e.node === serviceB);
    if (exists) {
      console.warn(`Edge ${serviceA} → ${serviceB} already exists`);
      return;
    }

    // Add forward edge (dependencies)
    this.graph.get(serviceA).push({ node: serviceB, type });

    // Add reverse edge (dependents)
    this.dependents.get(serviceB).push({ node: serviceA, type });

    console.log(`✓ Added edge: ${serviceA} → ${serviceB} (${type})`);
  }

  /**
   * Update node state and propagate changes
   * @param {string} service - Service to update
   * @param {Object} newState - { status, restartCount, errorRate }
   */
  updateNodeState(service, newState) {
    if (!this.nodeState.has(service)) {
      throw new Error(`Service ${service} not found`);
    }

    const oldState = { ...this.nodeState.get(service) };
    const updated = { ...oldState, ...newState };

    this.nodeState.set(service, updated);

    console.log(`\n[UPDATE] ${service}: ${oldState.status} → ${updated.status}`);

    // Propagate to dependents (reverse traversal)
    this._propagateToDependent(service);
  }

  /**
   * Propagate state changes to services that depend on this one
   * @param {string} service - Service that changed
   * @private
   */
  _propagateToDependent(service) {
    const dependentServices = this.dependents.get(service) || [];
    const currentState = this.nodeState.get(service);

    for (const dep of dependentServices) {
      const dependentService = dep.node;
      const dependentType = dep.type;
      const dependentState = this.nodeState.get(dependentService);

      if (!dependentState) continue;

      // PROPAGATION RULE 1: Hard dependency FAILED → dependent FAILS
      if (
        dependentType === 'hard' &&
        currentState.status === 'FAILED'
      ) {
        if (dependentState.status !== 'FAILED') {
          console.log(
            `  ↳ HARD FAILURE: ${service} FAILED → ${dependentService} FAILED`
          );
          this.nodeState.set(dependentService, {
            ...dependentState,
            status: 'FAILED',
          });

          // Recursive propagation
          this._propagateToDependent(dependentService);
        }
      }

      // PROPAGATION RULE 2: Soft dependency FAILED → dependent DEGRADED
      if (
        dependentType === 'soft' &&
        currentState.status === 'FAILED' &&
        dependentState.status === 'HEALTHY'
      ) {
        console.log(
          `  ↳ SOFT FAILURE: ${service} FAILED → ${dependentService} DEGRADED`
        );
        this.nodeState.set(dependentService, {
          ...dependentState,
          status: 'DEGRADED',
        });

        // Recursive propagation (soft doesn't cascade FAILED)
        this._propagateToDependent(dependentService);
      }

      // RECOVERY RULE: When dependency becomes HEALTHY
      if (
        currentState.status === 'HEALTHY' &&
        (dependentState.status === 'FAILED' || dependentState.status === 'DEGRADED')
      ) {
        // Check if ALL dependencies of dependent are now HEALTHY
        const allDepsHealthy = this._areAllDependenciesHealthy(dependentService);

        if (allDepsHealthy) {
          console.log(
            `  ↳ RECOVERY: All deps of ${dependentService} healthy → HEALTHY`
          );
          this.nodeState.set(dependentService, {
            ...dependentState,
            status: 'HEALTHY',
          });

          // Recursive recovery propagation
          this._propagateToDependent(dependentService);
        } else {
          // If not all deps are healthy, mark as DEGRADED (not FAILED)
          if (dependentState.status === 'FAILED') {
            console.log(
              `  ↳ PARTIAL RECOVERY: ${dependentService} degraded (not all deps healthy)`
            );
            this.nodeState.set(dependentService, {
              ...dependentState,
              status: 'DEGRADED',
            });
          }
        }
      }
    }
  }

  /**
   * Check if all dependencies of a service are HEALTHY
   * @param {string} service - Service to check
   * @returns {boolean}
   * @private
   */
  _areAllDependenciesHealthy(service) {
    const dependencies = this.graph.get(service) || [];

    for (const dep of dependencies) {
      const depState = this.nodeState.get(dep.node);
      if (!depState || depState.status !== 'HEALTHY') {
        return false;
      }
    }

    return true;
  }

  /**
   * Get direct dependencies of a service
   * @param {string} service - Service to query
   * @returns {Array<{node, type}>}
   */
  getDependencies(service) {
    if (!this.graph.has(service)) {
      return [];
    }
    return this.graph.get(service);
  }

  /**
   * Get direct dependents of a service
   * @param {string} service - Service to query
   * @returns {Array<{node, type}>}
   */
  getDependents(service) {
    if (!this.dependents.has(service)) {
      return [];
    }
    return this.dependents.get(service);
  }

  /**
   * Get state of a service
   * @param {string} service - Service to query
   * @returns {Object} - { status, restartCount, errorRate }
   */
  getNodeState(service) {
    return this.nodeState.get(service) || null;
  }

  /**
   * Get all nodes and their states
   * @returns {Object} - Map of all nodes and states
   */
  getAllNodes() {
    const result = {};
    for (const [service, state] of this.nodeState.entries()) {
      result[service] = state;
    }
    return result;
  }

  /**
   * Detect cycles using DFS
   * @returns {boolean} - True if cycle exists
   */
  hasCycle() {
    this.visited.clear();
    this.recursionStack.clear();

    for (const node of this.graph.keys()) {
      if (!this.visited.has(node)) {
        if (this._detectCycleDFS(node)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * DFS helper for cycle detection
   * @param {string} node - Current node
   * @returns {boolean}
   * @private
   */
  _detectCycleDFS(node) {
    this.visited.add(node);
    this.recursionStack.add(node);

    const deps = this.graph.get(node) || [];
    for (const dep of deps) {
      if (!this.visited.has(dep.node)) {
        if (this._detectCycleDFS(dep.node)) {
          return true;
        }
      } else if (this.recursionStack.has(dep.node)) {
        return true;
      }
    }

    this.recursionStack.delete(node);
    return false;
  }

  /**
   * Get graph structure for visualization
   * @returns {Object}
   */
  getGraphStructure() {
    const structure = {};

    for (const [service, deps] of this.graph.entries()) {
      structure[service] = deps.map(d => ({
        node: d.node,
        type: d.type,
        nodeStatus: this.nodeState.get(d.node)?.status || 'UNKNOWN',
      }));
    }

    return structure;
  }

  /**
   * Print graph in readable format
   */
  printGraph() {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║       DEPENDENCY GRAPH STATE           ║');
    console.log('╚════════════════════════════════════════╝\n');

    for (const [service, state] of this.nodeState.entries()) {
      const statusSymbol = this._getStatusSymbol(state.status);
      console.log(`${statusSymbol} ${service.padEnd(20)} [${state.status}]`);

      const deps = this.graph.get(service) || [];
      if (deps.length > 0) {
        deps.forEach((dep, idx) => {
          const depState = this.nodeState.get(dep.node);
          const isLast = idx === deps.length - 1;
          const prefix = isLast ? '    └─' : '    ├─';
          const depSymbol =
            dep.type === 'hard' ? '[HARD]' : '[SOFT]';
          const depStatus = depState?.status || 'UNKNOWN';
          console.log(
            `${prefix} → ${dep.node.padEnd(16)} ${depSymbol} (${depStatus})`
          );
        });
      }
      console.log();
    }
  }

  /**
   * Get status symbol for console output
   * @param {string} status - Status string
   * @returns {string}
   * @private
   */
  _getStatusSymbol(status) {
    switch (status) {
      case 'HEALTHY':
        return '✓';
      case 'DEGRADED':
        return '⚠';
      case 'FAILED':
        return '✗';
      default:
        return '?';
    }
  }
}

module.exports = DependencyGraph;
