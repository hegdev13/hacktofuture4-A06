/**
 * RCA Agent (Root Cause Analysis)
 * Builds dependency graphs and traces failure chains
 */

const config = require('../config');
const logger = require('../utils/logger');

class RCAAgent {
  constructor() {
    this.dependencyKeys = config.rca.dependencyKeys;
    this.maxDepth = config.rca.maxChainDepth;
  }

  /**
   * Perform root cause analysis
   */
  performRCA(clusterState, detectedIssues) {
    logger.timelineEvent('rca', `Starting RCA for ${detectedIssues.length} issue(s)`);

    if (!detectedIssues || detectedIssues.length === 0) {
      return {
        rootCause: null,
        failureChain: [],
        confidence: 0,
        reasoning: 'No issues to analyze',
      };
    }

    // Build dependency graph
    const dependencyGraph = this.buildDependencyGraph(clusterState);

    // Analyze each issue
    const results = [];
    for (const issue of detectedIssues) {
      const analysis = this.analyzeIssue(issue, dependencyGraph, clusterState);
      results.push(analysis);
    }

    // Prioritize by confidence and severity
    results.sort((a, b) => b.confidence - a.confidence);

    const primary = results[0];

    // Include the dependency graph for visualization
    const graphExport = this.exportGraph(dependencyGraph);

    logger.timelineEvent('rca', 'RCA completed', {
      rootCause: primary.rootCause,
      confidence: primary.confidence,
    });

    return {
      ...primary,
      graph: graphExport,
      allResults: results,
    };
  }

  /**
   * Build dynamic dependency graph from cluster state
   */
  buildDependencyGraph(clusterState) {
    const graph = {
      nodes: new Map(),
      edges: new Map(),
      services: new Map(),
    };

    const pods = clusterState.pods || [];
    const services = clusterState.services || [];

    // Add all pods as nodes
    for (const pod of pods) {
      graph.nodes.set(pod.name, {
        name: pod.name,
        namespace: pod.namespace,
        type: 'pod',
        status: pod.status || pod.phase,
        labels: pod.labels || {},
        dependencies: [],
      });
    }

    // Add services as nodes
    for (const svc of services) {
      graph.services.set(svc.name, {
        name: svc.name,
        namespace: svc.namespace,
        type: 'service',
        endpoints: svc.endpoints || [],
        selector: svc.selector || {},
      });
    }

    // Build edges from dependencies
    for (const pod of pods) {
      const deps = pod.dependencies || [];
      const podNode = graph.nodes.get(pod.name);

      if (!podNode) continue;

      for (const dep of deps) {
        const depNode = this.resolveDependency(dep, clusterState);
        if (depNode) {
          podNode.dependencies.push({
            type: dep.type,
            name: dep.name,
            target: dep.target,
            source: dep.source,
            resolvedTo: depNode.name,
          });

          // Add edge
          const edgeKey = `${pod.name}->${depNode.name}`;
          graph.edges.set(edgeKey, {
            from: pod.name,
            to: depNode.name,
            type: dep.type,
          });
        }
      }
    }

    // Infer database relationships
    this.inferDatabaseRelationships(graph, pods);

    // Infer additional relationships from labels
    this.inferRelationships(graph, pods);

    return graph;
  }

  /**
   * Infer database dependencies from naming patterns
   */
  inferDatabaseRelationships(graph, pods) {
    const dbPods = pods.filter(p => {
      const name = (p.name || '').toLowerCase();
      return name.includes('db') || name.includes('postgres') || name.includes('redis') ||
             name.includes('mongo') || name.includes('mysql') || name.includes('elasticsearch');
    });

    const appPods = pods.filter(p => {
      const name = (p.name || '').toLowerCase();
      return name.includes('api') || name.includes('app') || name.includes('web') ||
             name.includes('service') || name.includes('backend') || name.includes('worker');
    });

    for (const appPod of appPods) {
      const node = graph.nodes.get(appPod.name);
      if (!node) continue;

      for (const dbPod of dbPods) {
        // Check if in same namespace
        if (appPod.namespace === dbPod.namespace || appPod.namespace === 'default') {
          const alreadyHasDep = node.dependencies.some(d =>
            d.resolvedTo === dbPod.name || d.target?.includes(dbPod.name)
          );

          if (!alreadyHasDep) {
            node.dependencies.push({
              type: 'inferred-database',
              name: 'database',
              target: dbPod.name,
              source: 'inferred',
              resolvedTo: dbPod.name,
            });

            const edgeKey = `${appPod.name}->${dbPod.name}`;
            graph.edges.set(edgeKey, {
              from: appPod.name,
              to: dbPod.name,
              type: 'inferred-database',
            });
          }
        }
      }
    }
  }

  /**
   * Resolve dependency to actual pod/service
   */
  resolveDependency(dep, clusterState) {
    const target = dep.target;

    // Try to find by hostname pattern
    const pods = clusterState.pods || [];
    const services = clusterState.services || [];

    // Check if target matches a service
    for (const svc of services) {
      if (target.includes(svc.name) || svc.clusterIP === target) {
        return { name: svc.name, type: 'service' };
      }
    }

    // Check if target matches a pod
    for (const pod of pods) {
      if (target.includes(pod.name)) {
        return { name: pod.name, type: 'pod' };
      }

      // Check by labels
      const labels = pod.labels || {};
      for (const [key, value] of Object.entries(labels)) {
        if (target.includes(value)) {
          return { name: pod.name, type: 'pod' };
        }
      }
    }

    // Return unresolved reference
    return { name: target, type: 'external', unresolved: true };
  }

  /**
   * Infer relationships from labels and naming
   */
  inferRelationships(graph, pods) {
    // Group pods by app label
    const byApp = new Map();
    for (const pod of pods) {
      const app = pod.labels?.app || pod.labels?.['app.kubernetes.io/name'];
      if (app) {
        if (!byApp.has(app)) byApp.set(app, []);
        byApp.get(app).push(pod.name);
      }
    }

    // Create implicit edges within same app (version dependency)
    for (const [app, podNames] of byApp) {
      if (podNames.length > 1) {
        // These pods likely depend on each other
        for (let i = 0; i < podNames.length; i++) {
          const node = graph.nodes.get(podNames[i]);
          if (node) {
            for (let j = 0; j < podNames.length; j++) {
              if (i !== j) {
                node.dependencies.push({
                  type: 'co-located',
                  target: podNames[j],
                  implicit: true,
                });
              }
            }
          }
        }
      }
    }

    // Infer database dependencies from naming
    for (const pod of pods) {
      const name = pod.name.toLowerCase();
      const node = graph.nodes.get(pod.name);
      if (!node) continue;

      if (name.includes('api') || name.includes('web') || name.includes('app')) {
        // Look for database pods
        for (const otherPod of pods) {
          const otherName = otherPod.name.toLowerCase();
          if (otherName.includes('db') || otherName.includes('postgres') || otherName.includes('redis')) {
            // Infer dependency
            const alreadyHasDep = node.dependencies.some(
              d => d.resolvedTo === otherPod.name
            );
            if (!alreadyHasDep) {
              node.dependencies.push({
                type: 'inferred-db',
                target: otherPod.name,
                implicit: true,
              });

              const edgeKey = `${pod.name}->${otherPod.name}`;
              graph.edges.set(edgeKey, {
                from: pod.name,
                to: otherPod.name,
                type: 'inferred',
              });
            }
          }
        }
      }
    }
  }

  /**
   * Analyze a single issue
   */
  analyzeIssue(issue, dependencyGraph, clusterState) {
    const target = issue.target;
    const startNode = dependencyGraph.nodes.get(target);

    if (!startNode) {
      return {
        rootCause: target,
        failureChain: [issue.problem],
        confidence: 50,
        reasoning: 'Could not trace dependencies - treating as isolated issue',
        dependencies: [],
      };
    }

    // Trace failure chain
    const chain = this.traceFailureChain(startNode, dependencyGraph, clusterState);

    // Determine root cause
    const rootCause = this.identifyRootCause(chain, issue, clusterState);

    // Build reasoning
    const reasoning = this.buildReasoning(rootCause, chain, issue);

    // Calculate confidence
    const confidence = this.calculateConfidence(chain, rootCause, issue);

    return {
      rootCause: rootCause.name,
      rootCauseType: rootCause.type,
      failureChain: chain.map(c => c.description),
      confidence,
      reasoning,
      chainDetails: chain,
      affectedResources: this.getAffectedResources(chain),
    };
  }

  /**
   * Trace failure chain through dependencies
   * Uses BFS to trace the dependency chain and identify all affected resources
   */
  traceFailureChain(startNode, graph, clusterState) {
    const chain = [];
    const visited = new Set();
    const queue = [{ node: startNode, depth: 0, path: [] }];

    // First, trace UPSTREAM to find root cause (what this node depends on)
    while (queue.length > 0) {
      const { node, depth, path } = queue.shift();

      if (depth > this.maxDepth) continue;
      if (visited.has(node.name)) continue;
      visited.add(node.name);

      // Check if this node is unhealthy
      const health = this.checkNodeHealth(node, clusterState);

      const step = {
        name: node.name,
        type: node.type,
        depth,
        health,
        dependencies: node.dependencies.length,
        path: [...path],
        description: health.healthy
          ? `${node.name} is healthy`
          : `${node.name}: ${health.reason}`,
      };

      chain.push(step);

      // Always trace dependencies to find root cause
      // Root cause is at the deepest level of failed dependencies
      for (const dep of node.dependencies) {
        const depNode = graph.nodes.get(dep.resolvedTo) ||
                       graph.nodes.get(dep.target);
        if (depNode && !visited.has(depNode.name)) {
          queue.push({
            node: depNode,
            depth: depth + 1,
            path: [...path, node.name],
          });
        }
      }
    }

    // Sort by depth ascending (root cause first), then by health
    return chain.sort((a, b) => {
      // Primary sort: depth (ascending - root cause at top)
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      // Secondary sort: unhealthy first
      if (a.health.healthy !== b.health.healthy) {
        return a.health.healthy ? 1 : -1;
      }
      return 0;
    });
  }

  /**
   * Check health of a node
   */
  checkNodeHealth(node, clusterState) {
    const pods = clusterState.pods || [];
    const pod = pods.find(p => p.name === node.name);

    if (!pod) {
      return { healthy: false, reason: 'Pod not found in cluster state' };
    }

    const phase = (pod.phase || pod.status || '').toLowerCase();

    if (['failed', 'error', 'crashloopbackoff'].includes(phase)) {
      return { healthy: false, reason: `Pod in ${phase} state` };
    }

    if (phase === 'pending') {
      return { healthy: false, reason: 'Pod stuck pending' };
    }

    if (pod.restarts >= config.severity.thresholds.restarts.critical) {
      return { healthy: false, reason: `Excessive restarts (${pod.restarts})` };
    }

    if (pod.cpu > config.severity.thresholds.cpu.critical) {
      return { healthy: false, reason: `Critical CPU usage (${pod.cpu}%)` };
    }

    if (pod.memory > config.severity.thresholds.memory.critical) {
      return { healthy: false, reason: `Critical memory usage (${pod.memory}%)` };
    }

    return { healthy: true, reason: 'All checks passed' };
  }

  /**
   * Identify root cause from chain
   * Root cause is the deepest failed dependency in the chain
   * (the one at the highest depth that is unhealthy)
   */
  identifyRootCause(chain, issue, clusterState) {
    // Filter to only unhealthy nodes
    const unhealthy = chain.filter(c => !c.health.healthy);

    if (unhealthy.length > 0) {
      // Sort by depth descending (deepest first) to find the root cause
      // The root cause is typically the deepest failed dependency
      unhealthy.sort((a, b) => b.depth - a.depth);

      // Get the deepest unhealthy node (the actual root cause)
      const rootCause = unhealthy[0];

      return {
        name: rootCause.name,
        type: rootCause.type,
        depth: rootCause.depth,
        reason: rootCause.health.reason,
        health: rootCause.health,
      };
    }

    // If all healthy, the issue is likely the reported pod itself
    return {
      name: issue.target,
      type: 'direct',
      depth: 0,
      reason: issue.problem,
      health: { healthy: false, reason: issue.problem },
    };
  }

  /**
   * Build human-readable reasoning
   */
  buildReasoning(rootCause, chain, issue) {
    const parts = [];

    parts.push(`Detected issue: ${issue.problem} in ${issue.target}`);

    if (chain.length > 1) {
      parts.push(`Traced ${chain.length - 1} dependency level(s)`);
    }

    if (rootCause.depth > 0) {
      parts.push(`Root cause identified as ${rootCause.name} (dependency level ${rootCause.depth}): ${rootCause.reason}`);
      parts.push(`The failure cascaded from ${rootCause.name} to affect ${issue.target}`);
    } else if (rootCause.name !== issue.target) {
      parts.push(`Root cause identified as ${rootCause.name}: ${rootCause.reason}`);
      parts.push(`This is an independent failure affecting ${issue.target}`);
    } else {
      parts.push(`Root cause is the reported resource itself: ${rootCause.reason}`);
      parts.push(`No dependency failures detected - this is a direct issue with ${issue.target}`);
    }

    // Add affected resources info
    const affectedCount = chain.filter(c => !c.health.healthy).length;
    if (affectedCount > 1) {
      parts.push(`Found ${affectedCount} affected resources in the failure chain`);
    }

    return parts.join('. ');
  }

  /**
   * Calculate confidence score
   */
  calculateConfidence(chain, rootCause, issue) {
    let confidence = 60; // Base confidence (increased from 50)

    // Higher confidence if we found deeper dependencies with actual root cause
    if (rootCause.depth > 0) {
      confidence += Math.min(25, rootCause.depth * 8);
    }

    // Higher confidence if root cause is different from the reported issue
    // (shows we actually traced dependencies)
    if (rootCause.name !== issue.target) {
      confidence += 15;
    }

    // Higher confidence if chain has multiple unhealthy nodes
    const unhealthyCount = chain.filter(c => !c.health.healthy).length;
    if (unhealthyCount > 1) {
      confidence += Math.min(15, (unhealthyCount - 1) * 5);
    }

    // Lower confidence if chain is too short (may have missed dependencies)
    if (chain.length <= 1) {
      confidence -= 15;
    }

    // Higher confidence for clear error patterns
    if (issue.metric === 'restarts' || issue.metric === 'oom') {
      confidence += 10;
    }

    // Higher confidence for crash loops
    if (issue.metric === 'restarts' && issue.severity === 'high') {
      confidence += 5;
    }

    // Lower confidence if the root cause is healthy (shouldn't happen often)
    if (rootCause.health?.healthy) {
      confidence -= 25;
    }

    return Math.min(100, Math.max(0, confidence));
  }

  /**
   * Get all affected resources from chain
   */
  getAffectedResources(chain) {
    return chain.map(c => ({
      name: c.name,
      type: c.type,
      health: c.health,
    }));
  }

  /**
   * Export dependency graph for visualization
   */
  exportGraph(dependencyGraph) {
    return {
      nodes: Array.from(dependencyGraph.nodes.values()),
      edges: Array.from(dependencyGraph.edges.values()),
    };
  }
}

// Export singleton
module.exports = new RCAAgent();
