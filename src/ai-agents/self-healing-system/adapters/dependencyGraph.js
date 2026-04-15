/**
 * Dependency Graph Manager
 * Automatically maps pod dependencies and relationships
 */

class DependencyGraph {
  constructor() {
    this.dependencies = {};
    this.reverseDepMap = {}; // What depends on this pod
    this.initializeDefaultDependencies();
  }

  /**
   * Initialize default microservice dependencies
   */
  initializeDefaultDependencies() {
    // Common microservice topology
    this.dependencies = {
      'frontend (deployment)': {
        dependsOn: ['api-gateway (deployment)', 'auth-service (deployment)'],
        criticality: 'high',
        services: ['web', 'ui']
      },
      'api-gateway (deployment)': {
        dependsOn: ['auth-service (deployment)', 'user-service (deployment)', 'order-service (deployment)'],
        criticality: 'critical',
        services: ['api', 'gateway']
      },
      'auth-service (deployment)': {
        dependsOn: ['redis (statefulset)', 'postgres (deployment)'],
        criticality: 'critical',
        services: ['auth', 'security']
      },
      'paymentservice (deployment)': {
        dependsOn: ['postgres (deployment)', 'message-queue (deployment)', 'vault (deployment)'],
        criticality: 'critical',
        services: ['payments', 'transactions']
      },
      'order-service (deployment)': {
        dependsOn: ['postgres (deployment)', 'message-queue (deployment)'],
        criticality: 'high',
        services: ['orders', 'commerce']
      },
      'user-service (deployment)': {
        dependsOn: ['postgres (deployment)', 'redis (statefulset)'],
        criticality: 'high',
        services: ['users', 'profiles']
      },
      'postgres (deployment)': {
        dependsOn: [],
        criticality: 'critical',
        services: ['database', 'data']
      },
      'redis (statefulset)': {
        dependsOn: [],
        criticality: 'high',
        services: ['cache', 'session']
      },
      'message-queue (deployment)': {
        dependsOn: [],
        criticality: 'high',
        services: ['messaging', 'events']
      },
      'vault (deployment)': {
        dependsOn: [],
        criticality: 'high',
        services: ['secrets', 'security']
      }
    };

    this.buildReverseMap();
  }

  /**
   * Build reverse dependency map (what depends on each pod)
   */
  buildReverseMap() {
    this.reverseDepMap = {};

    Object.entries(this.dependencies).forEach(([pod, info]) => {
      if (!this.reverseDepMap[pod]) {
        this.reverseDepMap[pod] = [];
      }

      info.dependsOn?.forEach(dep => {
        if (!this.reverseDepMap[dep]) {
          this.reverseDepMap[dep] = [];
        }
        this.reverseDepMap[dep].push(pod);
      });
    });
  }

  /**
   * Get pods affected by a failed pod
   */
  getAffectedPods(failedPod) {
    return this.reverseDepMap[failedPod] || [];
  }

  /**
   * Get all pods that depend on failed pod (cascade)
   */
  getCascadingFailures(failedPods) {
    const affected = new Set();
    const queue = [...failedPods];

    while (queue.length > 0) {
      const pod = queue.shift();
      const dependents = this.reverseDepMap[pod] || [];

      dependents.forEach(dep => {
        if (!affected.has(dep)) {
          affected.add(dep);
          queue.push(dep);
        }
      });
    }

    return Array.from(affected);
  }

  /**
   * Get dependency chain for a pod
   */
  getDependencyChain(pod) {
    const chain = [];
    const visited = new Set();

    const traverse = (current, depth = 0) => {
      if (visited.has(current)) return;
      visited.add(current);

      const deps = this.dependencies[current];
      if (deps) {
        chain.push({
          pod: current,
          depth,
          criticality: deps.criticality,
          services: deps.services
        });

        deps.dependsOn?.forEach(dep => traverse(dep, depth + 1));
      }
    };

    traverse(pod);
    return chain;
  }

  /**
   * Analyze impact of failures
   */
  analyzeFailureImpact(failedPods) {
    const analysis = {
      failedPods,
      directAffected: [],
      cascadingAffected: [],
      criticalPathImpact: false,
      estimatedDowntime: 0,
      impactScore: 0,
      recommendations: []
    };

    // Get all affected pods
    const allAffected = new Set();
    failedPods.forEach(pod => {
      const affected = this.getAffectedPods(pod);
      affected.forEach(a => allAffected.add(a));
      analysis.directAffected.push(...affected);
    });

    // Get cascading failures
    const cascading = this.getCascadingFailures(failedPods);
    analysis.cascadingAffected = cascading;

    // Check if critical path is affected
    const criticalPods = Object.entries(this.dependencies)
      .filter(([, info]) => info.criticality === 'critical')
      .map(([pod]) => pod);

    analysis.criticalPathImpact = failedPods.some(p => 
      criticalPods.includes(p) || cascading.some(c => criticalPods.includes(c))
    );

    // Calculate impact score
    analysis.impactScore = 
      (failedPods.length * 30) +  // Direct failures
      (cascading.length * 20) +   // Cascading
      (analysis.criticalPathImpact ? 40 : 0);  // Critical impact

    // Estimate downtime (in seconds)
    analysis.estimatedDowntime = Math.min(300, 30 + cascading.length * 10);

    // Generate recommendations
    if (analysis.criticalPathImpact) {
      analysis.recommendations.push('🔴 CRITICAL: Initiate emergency recovery procedure');
    }
    if (cascading.length > 3) {
      analysis.recommendations.push('⚠️  High cascade risk: Prioritize failed pod recovery');
    }
    if (failedPods.includes('paymentservice (deployment)')) {
      analysis.recommendations.push('💳 Payment service down: Enable fallback/offline mode');
    }
    if (failedPods.includes('auth-service (deployment)')) {
      analysis.recommendations.push('🔐 Auth service down: All dependent services at risk');
    }

    return analysis;
  }

  /**
   * Get graph data for visualization
   */
  getGraphData() {
    const nodes = [];
    const links = [];
    const nodeMap = new Map();

    // Create nodes
    Object.entries(this.dependencies).forEach(([pod, info]) => {
      const node = {
        id: pod,
        label: pod.split(' ')[0],
        criticality: info.criticality,
        services: info.services,
        size: info.criticality === 'critical' ? 30 : 20
      };
      nodes.push(node);
      nodeMap.set(pod, node);
    });

    // Create links
    Object.entries(this.dependencies).forEach(([pod, info]) => {
      info.dependsOn?.forEach(dep => {
        links.push({
          source: pod,
          target: dep,
          criticality: info.criticality
        });
      });
    });

    return { nodes, links };
  }

  /**
   * Format dependency info for display
   */
  formatDependencyInfo(pod) {
    const info = this.dependencies[pod];
    if (!info) return null;

    return {
      pod,
      criticality: info.criticality,
      services: info.services,
      dependsOn: info.dependsOn,
      dependentServices: this.reverseDepMap[pod] || [],
      chain: this.getDependencyChain(pod)
    };
  }
}

module.exports = DependencyGraph;
