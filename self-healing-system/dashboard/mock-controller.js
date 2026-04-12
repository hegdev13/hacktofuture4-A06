/**
 * Mock Cluster Controller
 * Manages simulated cluster state with manual controls for testing RCA
 */

const { EventEmitter } = require('events');
const logger = require('../utils/logger');

class MockClusterController extends EventEmitter {
  constructor() {
    super();
    this.pods = new Map();
    this.services = new Map();
    this.nodes = new Map();
    this.initialized = false;
    this.scenarioType = 'cascade'; // cascade, isolated, multi-root, cyclic
    this.autoHeal = false;

    // Define dependency scenarios
    this.scenarios = {
      // Simple cascade: Database -> API -> Frontend
      cascade: {
        name: 'Cascading Failure',
        description: 'Database failure cascades to API and Frontend',
        pods: [
          { name: 'frontend-web', type: 'frontend', dependencies: ['api-gateway'], labels: { app: 'frontend', tier: 'web' } },
          { name: 'api-gateway', type: 'api', dependencies: ['user-service', 'order-service'], labels: { app: 'api', tier: 'gateway' } },
          { name: 'user-service', type: 'service', dependencies: ['postgres-db'], labels: { app: 'user', tier: 'service' } },
          { name: 'order-service', type: 'service', dependencies: ['postgres-db', 'redis-cache'], labels: { app: 'order', tier: 'service' } },
          { name: 'postgres-db', type: 'database', dependencies: [], labels: { app: 'postgres', tier: 'database' } },
          { name: 'redis-cache', type: 'cache', dependencies: [], labels: { app: 'redis', tier: 'cache' } },
        ]
      },
      // Multiple independent failures
      isolated: {
        name: 'Isolated Failures',
        description: 'Multiple independent service failures',
        pods: [
          { name: 'web-app-1', type: 'frontend', dependencies: [], labels: { app: 'web', instance: '1' } },
          { name: 'web-app-2', type: 'frontend', dependencies: [], labels: { app: 'web', instance: '2' } },
          { name: 'worker-1', type: 'worker', dependencies: [], labels: { app: 'worker', instance: '1' } },
          { name: 'worker-2', type: 'worker', dependencies: [], labels: { app: 'worker', instance: '2' } },
          { name: 'scheduler', type: 'scheduler', dependencies: [], labels: { app: 'scheduler' } },
        ]
      },
      // Multiple roots affecting shared resources
      'multi-root': {
        name: 'Multi-Root Cascade',
        description: 'Two database failures cascade to shared services',
        pods: [
          { name: 'api-gateway', type: 'gateway', dependencies: ['user-db', 'product-db'], labels: { app: 'gateway' } },
          { name: 'user-service', type: 'service', dependencies: ['user-db'], labels: { app: 'user-service' } },
          { name: 'product-service', type: 'service', dependencies: ['product-db'], labels: { app: 'product-service' } },
          { name: 'user-db', type: 'database', dependencies: [], labels: { app: 'user-db' } },
          { name: 'product-db', type: 'database', dependencies: [], labels: { app: 'product-db' } },
          { name: 'cache-redis', type: 'cache', dependencies: [], labels: { app: 'redis' } },
        ]
      },
      // Deep dependency chain
      deep: {
        name: 'Deep Dependency Chain',
        description: '5-level deep dependency chain',
        pods: [
          { name: 'client-app', type: 'frontend', dependencies: ['edge-proxy'], labels: { layer: '1' } },
          { name: 'edge-proxy', type: 'proxy', dependencies: ['load-balancer'], labels: { layer: '2' } },
          { name: 'load-balancer', type: 'lb', dependencies: ['app-server'], labels: { layer: '3' } },
          { name: 'app-server', type: 'app', dependencies: ['data-access'], labels: { layer: '4' } },
          { name: 'data-access', type: 'dal', dependencies: ['primary-db'], labels: { layer: '5' } },
          { name: 'primary-db', type: 'database', dependencies: [], labels: { layer: '6' } },
        ]
      },
      // Circular dependency (unhealthy detection)
      circular: {
        name: 'Circular Dependencies',
        description: 'Services with bidirectional dependencies',
        pods: [
          { name: 'service-a', type: 'service', dependencies: ['service-b'], labels: { app: 'a' } },
          { name: 'service-b', type: 'service', dependencies: ['service-c'], labels: { app: 'b' } },
          { name: 'service-c', type: 'service', dependencies: ['service-a'], labels: { app: 'c' } },
          { name: 'shared-db', type: 'database', dependencies: [], labels: { app: 'db' } },
        ]
      }
    };

    this.initialize();
  }

  initialize() {
    if (this.initialized) return;

    // Create default nodes
    this.nodes.set('node-1', {
      name: 'node-1',
      status: 'Ready',
      conditions: []
    });

    this.loadScenario('cascade');
    this.initialized = true;

    logger.info('MockClusterController initialized');
  }

  /**
   * Load a specific scenario
   */
  loadScenario(scenarioName) {
    const scenario = this.scenarios[scenarioName];
    if (!scenario) {
      logger.error(`Unknown scenario: ${scenarioName}`);
      return false;
    }

    this.scenarioType = scenarioName;
    this.pods.clear();
    this.services.clear();

    // Create pods with healthy initial state
    for (const podDef of scenario.pods) {
      this.pods.set(podDef.name, this.createHealthyPod(podDef));
    }

    // Create services for each pod
    for (const podDef of scenario.pods) {
      this.services.set(podDef.name, {
        name: `${podDef.name}-svc`,
        namespace: 'default',
        selector: { app: podDef.labels.app },
        endpoints: [podDef.name],
        clusterIP: `10.0.0.${Math.floor(Math.random() * 255)}`
      });
    }

    logger.timelineEvent('success', `Loaded scenario: ${scenario.name}`);
    this.emit('stateChanged', this.getClusterState());
    return true;
  }

  createHealthyPod(podDef) {
    return {
      name: podDef.name,
      namespace: 'default',
      status: 'Running',
      phase: 'Running',
      ready: true,
      restarts: 0,
      cpu: Math.floor(Math.random() * 30) + 10, // 10-40%
      memory: Math.floor(Math.random() * 30) + 20, // 20-50%
      labels: podDef.labels,
      dependencies: podDef.dependencies.map(dep => ({
        type: 'service',
        target: dep,
        name: dep
      })),
      logs: ['Service started successfully', 'Connected to dependencies'],
      nodeName: 'node-1',
      ip: `10.244.0.${Math.floor(Math.random() * 255)}`,
      podType: podDef.type,
      creationTime: new Date().toISOString()
    };
  }

  /**
   * Get current cluster state
   */
  getClusterState() {
    return {
      pods: Array.from(this.pods.values()),
      services: Array.from(this.services.values()),
      nodes: Array.from(this.nodes.values()),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Set pod health status
   */
  setPodHealth(podName, healthy, reason = null) {
    const pod = this.pods.get(podName);
    if (!pod) {
      logger.error(`Pod not found: ${podName}`);
      return false;
    }

    if (healthy) {
      pod.status = 'Running';
      pod.phase = 'Running';
      pod.ready = true;
      pod.logs = ['Service recovered', 'All health checks passing'];
      logger.timelineEvent('success', `Pod ${podName} restored to healthy state`);
    } else {
      // Pick a random failure mode
      const failureModes = [
        { status: 'Failed', phase: 'Failed', reason: 'Container crashed with exit code 1' },
        { status: 'CrashLoopBackOff', phase: 'CrashLoopBackOff', reason: 'Container repeatedly crashing' },
        { status: 'Pending', phase: 'Pending', reason: 'Stuck in pending state - resource constraints' },
        { status: 'Failed', phase: 'Failed', reason: 'OOMKilled - Out of memory' },
        { status: 'Error', phase: 'Error', reason: 'Image pull failed' },
      ];
      const failure = failureModes[Math.floor(Math.random() * failureModes.length)];

      pod.status = failure.status;
      pod.phase = failure.phase;
      pod.ready = false;
      pod.restarts += Math.floor(Math.random() * 5) + 1;
      pod.logs = [
        `ERROR: ${reason || failure.reason}`,
        'Connection refused to dependency',
        'Retry attempt failed',
        'Fatal: Unable to start service'
      ];

      logger.timelineEvent('issue', `Pod ${podName} marked as unhealthy: ${failure.reason}`);
    }

    this.emit('stateChanged', this.getClusterState());
    return true;
  }

  /**
   * Simulate cascading failure from a root cause
   */
  simulateCascadingFailure(rootPodName, delay = 1000) {
    const pod = this.pods.get(rootPodName);
    if (!pod) return false;

    // First fail the root
    this.setPodHealth(rootPodName, false, 'Simulated root cause failure');

    // Find all pods that depend on this one (directly or transitively)
    const affectedPods = this.findDependentPods(rootPodName);

    // Fail them with delays to simulate cascade
    affectedPods.forEach((affectedName, index) => {
      if (affectedName !== rootPodName) {
        setTimeout(() => {
          this.setPodHealth(affectedName, false, `Dependency ${rootPodName} unhealthy`);
        }, delay * (index + 1));
      }
    });

    return true;
  }

  /**
   * Find all pods that depend on a given pod (transitive)
   */
  findDependentPods(podName, visited = new Set()) {
    const dependents = [podName];
    visited.add(podName);

    for (const [name, pod] of this.pods) {
      if (visited.has(name)) continue;

      const deps = pod.dependencies || [];
      const dependsOnPod = deps.some(d =>
        d.target === podName || d.resolvedTo === podName
      );

      if (dependsOnPod) {
        dependents.push(name);
        visited.add(name);

        // Recursively find dependents of this pod
        const transitive = this.findDependentPods(name, visited);
        for (const t of transitive) {
          if (!dependents.includes(t)) {
            dependents.push(t);
          }
        }
      }
    }

    return dependents;
  }

  /**
   * Find the dependency path from root to target
   */
  findDependencyPath(targetPodName, rootPodName) {
    const path = [];
    const visited = new Set();

    const findPath = (current, target) => {
      if (current === target) return true;
      if (visited.has(current)) return false;
      visited.add(current);

      const pod = this.pods.get(current);
      if (!pod) return false;

      for (const dep of pod.dependencies || []) {
        const depName = dep.resolvedTo || dep.target;
        if (findPath(depName, target)) {
          path.unshift(depName);
          return true;
        }
      }
      return false;
    };

    findPath(targetPodName, rootPodName);
    path.push(targetPodName);
    return path;
  }

  /**
   * Heal all pods (reset to healthy)
   */
  healAll() {
    for (const [name, pod] of this.pods) {
      this.setPodHealth(name, true);
    }
    logger.timelineEvent('success', 'All pods healed');
    this.emit('stateChanged', this.getClusterState());
  }

  /**
   * Get current scenario info
   */
  getCurrentScenario() {
    return {
      name: this.scenarioType,
      ...this.scenarios[this.scenarioType],
      podCount: this.pods.size
    };
  }

  /**
   * Get available scenarios
   */
  getScenarios() {
    return Object.entries(this.scenarios).map(([key, value]) => ({
      id: key,
      name: value.name,
      description: value.description,
      podCount: value.pods.length
    }));
  }

  /**
   * Get pod details with dependency info
   */
  getPodDetails(podName) {
    const pod = this.pods.get(podName);
    if (!pod) return null;

    const dependents = [];
    for (const [name, p] of this.pods) {
      const deps = p.dependencies || [];
      if (deps.some(d => d.target === podName || d.resolvedTo === podName)) {
        dependents.push(name);
      }
    }

    return {
      ...pod,
      dependents,
      dependsOn: pod.dependencies?.map(d => d.target) || []
    };
  }

  /**
   * Randomize resource usage for all pods
   */
  randomizeMetrics() {
    for (const [name, pod] of this.pods) {
      pod.cpu = Math.floor(Math.random() * 80) + 10;
      pod.memory = Math.floor(Math.random() * 70) + 20;
    }
    this.emit('stateChanged', this.getClusterState());
  }

  /**
   * Cause resource exhaustion on a pod
   */
  exhaustResources(podName, resourceType = 'memory') {
    const pod = this.pods.get(podName);
    if (!pod) return false;

    if (resourceType === 'memory' || resourceType === 'both') {
      pod.memory = 98 + Math.random() * 2; // 98-100%
    }
    if (resourceType === 'cpu' || resourceType === 'both') {
      pod.cpu = 98 + Math.random() * 2; // 98-100%
    }

    pod.status = 'Failed';
    pod.phase = 'Failed';
    pod.ready = false;
    pod.logs.push(`CRITICAL: ${resourceType.toUpperCase()} exhausted`);

    logger.timelineEvent('issue', `${podName} exhausted ${resourceType}`);
    this.emit('stateChanged', this.getClusterState());
    return true;
  }
}

module.exports = MockClusterController;
