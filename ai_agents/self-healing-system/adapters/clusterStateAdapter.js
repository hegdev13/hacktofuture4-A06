/**
 * Cluster State Adapter
 * Flexible input handler that normalizes any cluster state format
 * Handles missing fields, additional fields, and unknown structures
 */

const config = require('../config');

class ClusterStateAdapter {
  constructor() {
    this.defaults = config.adapter.defaultValues;
    this.strictMode = config.adapter.strictMode;
  }

  /**
   * Normalize and validate cluster state
   * Returns a standardized format regardless of input structure
   */
  normalize(clusterState) {
    if (!clusterState || typeof clusterState !== 'object') {
      return this.createEmptyState();
    }

    const normalized = {
      timestamp: clusterState.timestamp || new Date().toISOString(),
      source: clusterState.source || 'unknown',
      nodes: this.normalizeNodes(clusterState.nodes),
      pods: this.normalizePods(clusterState.pods),
      services: this.normalizeServices(clusterState.services),
      deployments: this.normalizeDeployments(clusterState.deployments),
      metrics: this.normalizeMetrics(clusterState.metrics),
      logs: this.normalizeLogs(clusterState.logs),
      events: this.normalizeEvents(clusterState.events),
      raw: this.strictMode ? undefined : clusterState, // Preserve original for flexible access
    };

    return normalized;
  }

  /**
   * Create empty state structure
   */
  createEmptyState() {
    return {
      timestamp: new Date().toISOString(),
      source: 'empty',
      nodes: [],
      pods: [],
      services: [],
      metrics: {},
      logs: [],
      events: [],
    };
  }

  /**
   * Normalize nodes array
   */
  normalizeNodes(nodes) {
    if (!Array.isArray(nodes)) return [];

    return nodes.map(node => ({
      name: this.getString(node, 'name', 'unknown-node'),
      status: this.getString(node, 'status', 'unknown'),
      cpu: this.getNumber(node, 'cpu', this.defaults.cpu),
      memory: this.getNumber(node, 'memory', this.defaults.memory),
      capacity: this.getObject(node, 'capacity', {}),
      allocatable: this.getObject(node, 'allocatable', {}),
      conditions: this.getArray(node, 'conditions', []),
      labels: this.getObject(node, 'labels', {}),
      annotations: this.getObject(node, 'annotations', {}),
      // Preserve any additional fields
      ...this.getAdditionalFields(node, ['name', 'status', 'cpu', 'memory', 'capacity', 'allocatable', 'conditions', 'labels', 'annotations']),
    }));
  }

  /**
   * Normalize pods array
   */
  normalizePods(pods) {
    if (!Array.isArray(pods)) return [];

    return pods.map(pod => ({
      name: this.getString(pod, 'name', 'unknown-pod'),
      namespace: this.getString(pod, 'namespace', this.defaults.namespace),
      status: this.getString(pod, 'status', this.defaults.status),
      phase: this.getString(pod, 'phase', 'Unknown'),
      cpu: this.getNumber(pod, 'cpu', this.defaults.cpu),
      memory: this.getNumber(pod, 'memory', this.defaults.memory),
      restarts: this.getNumber(pod, 'restarts', this.defaults.restarts),
      ready: this.getBoolean(pod, 'ready', false),
      containers: this.getArray(pod, 'containers', []),
      logs: this.getArray(pod, 'logs', []),
      labels: this.getObject(pod, 'labels', {}),
      annotations: this.getObject(pod, 'annotations', {}),
      env: this.getObject(pod, 'env', {}),
      nodeName: this.getString(pod, 'nodeName', ''),
      creationTime: this.getString(pod, 'creationTime', ''),
      // Extract dependencies from various sources
      dependencies: this.extractDependencies(pod),
      // Preserve additional fields
      ...this.getAdditionalFields(pod, ['name', 'namespace', 'status', 'phase', 'cpu', 'memory', 'restarts', 'ready', 'containers', 'logs', 'labels', 'annotations', 'env', 'nodeName', 'creationTime']),
    }));
  }

  /**
   * Normalize services array
   */
  normalizeServices(services) {
    if (!Array.isArray(services)) return [];

    return services.map(service => ({
      name: this.getString(service, 'name', 'unknown-service'),
      namespace: this.getString(service, 'namespace', this.defaults.namespace),
      type: this.getString(service, 'type', 'ClusterIP'),
      clusterIP: this.getString(service, 'clusterIP', ''),
      externalIPs: this.getArray(service, 'externalIPs', []),
      ports: this.getArray(service, 'ports', []),
      selector: this.getObject(service, 'selector', {}),
      labels: this.getObject(service, 'labels', {}),
      endpoints: this.getArray(service, 'endpoints', []),
      ...this.getAdditionalFields(service, ['name', 'namespace', 'type', 'clusterIP', 'externalIPs', 'ports', 'selector', 'labels', 'endpoints']),
    }));
  }

  /**
   * Normalize deployments array
   */
  normalizeDeployments(deployments) {
    if (!Array.isArray(deployments)) return [];

    return deployments.map(deployment => ({
      name: this.getString(deployment, 'name', 'unknown-deployment'),
      namespace: this.getString(deployment, 'namespace', this.defaults.namespace),
      replicas: this.getNumber(deployment, 'replicas', 0),
      desiredReplicas: this.getNumber(deployment, 'desiredReplicas', deployment.replicas || 0),
      readyReplicas: this.getNumber(deployment, 'readyReplicas', 0),
      availableReplicas: this.getNumber(deployment, 'availableReplicas', 0),
      updatedReplicas: this.getNumber(deployment, 'updatedReplicas', 0),
      status: this.getString(deployment, 'status', 'unknown'),
      selector: this.getObject(deployment, 'selector', {}),
      labels: this.getObject(deployment, 'labels', {}),
      conditions: this.getArray(deployment, 'conditions', []),
      ...this.getAdditionalFields(deployment, ['name', 'namespace', 'replicas', 'desiredReplicas', 'readyReplicas', 'availableReplicas', 'updatedReplicas', 'status', 'selector', 'labels', 'conditions']),
    }));
  }

  /**
   * Normalize metrics object
   */
  normalizeMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object') return {};

    return {
      cluster: this.getObject(metrics, 'cluster', {}),
      nodes: this.getObject(metrics, 'nodes', {}),
      pods: this.getObject(metrics, 'pods', {}),
      ...this.getAdditionalFields(metrics, ['cluster', 'nodes', 'pods']),
    };
  }

  /**
   * Normalize logs array
   */
  normalizeLogs(logs) {
    if (!Array.isArray(logs)) return [];

    return logs.map(log => ({
      timestamp: this.getString(log, 'timestamp', new Date().toISOString()),
      pod: this.getString(log, 'pod', 'unknown'),
      container: this.getString(log, 'container', ''),
      level: this.getString(log, 'level', 'info'),
      message: this.getString(log, 'message', ''),
      ...this.getAdditionalFields(log, ['timestamp', 'pod', 'container', 'level', 'message']),
    }));
  }

  /**
   * Normalize events array
   */
  normalizeEvents(events) {
    if (!Array.isArray(events)) return [];

    return events.map(event => ({
      timestamp: this.getString(event, 'timestamp', new Date().toISOString()),
      type: this.getString(event, 'type', 'Normal'),
      reason: this.getString(event, 'reason', ''),
      object: this.getString(event, 'object', ''),
      message: this.getString(event, 'message', ''),
      ...this.getAdditionalFields(event, ['timestamp', 'type', 'reason', 'object', 'message']),
    }));
  }

  /**
   * Extract dependencies from pod (env, labels, annotations)
   */
  extractDependencies(pod) {
    const dependencies = [];

    // Extract from environment variables
    const env = this.getObject(pod, 'env', {});
    Object.entries(env).forEach(([key, value]) => {
      if (this.isDependencyKey(key)) {
        dependencies.push({
          type: this.classifyDependency(key),
          name: key,
          target: value,
          source: 'env',
        });
      }
    });

    // Extract from labels
    const labels = this.getObject(pod, 'labels', {});
    Object.entries(labels).forEach(([key, value]) => {
      if (this.isRelationshipLabel(key)) {
        dependencies.push({
          type: 'label-based',
          name: key,
          target: value,
          source: 'label',
        });
      }
    });

    return dependencies;
  }

  /**
   * Check if key indicates a dependency
   */
  isDependencyKey(key) {
    const patterns = config.rca.dependencyKeys.map(k => k.toLowerCase());
    return patterns.some(pattern => key.toLowerCase().includes(pattern));
  }

  /**
   * Check if label indicates a relationship
   */
  isRelationshipLabel(key) {
    const patterns = config.rca.relationshipLabels;
    return patterns.some(pattern => key.toLowerCase().includes(pattern));
  }

  /**
   * Classify dependency type
   */
  classifyDependency(key) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('db') || lowerKey.includes('database') || lowerKey.includes('postgres')) return 'database';
    if (lowerKey.includes('redis') || lowerKey.includes('cache')) return 'cache';
    if (lowerKey.includes('kafka') || lowerKey.includes('mq') || lowerKey.includes('queue')) return 'queue';
    if (lowerKey.includes('api') || lowerKey.includes('upstream') || lowerKey.includes('backend')) return 'upstream';
    return 'service';
  }

  /**
   * Safe getter methods
   */
  getString(obj, key, defaultValue) {
    if (!obj || typeof obj !== 'object') return defaultValue;
    const value = obj[key];
    return typeof value === 'string' ? value : defaultValue;
  }

  getNumber(obj, key, defaultValue) {
    if (!obj || typeof obj !== 'object') return defaultValue;
    const value = obj[key];
    return typeof value === 'number' && !isNaN(value) ? value : defaultValue;
  }

  getBoolean(obj, key, defaultValue) {
    if (!obj || typeof obj !== 'object') return defaultValue;
    const value = obj[key];
    return typeof value === 'boolean' ? value : defaultValue;
  }

  getArray(obj, key, defaultValue) {
    if (!obj || typeof obj !== 'object') return defaultValue;
    const value = obj[key];
    return Array.isArray(value) ? value : defaultValue;
  }

  getObject(obj, key, defaultValue) {
    if (!obj || typeof obj !== 'object') return defaultValue;
    const value = obj[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : defaultValue;
  }

  /**
   * Get additional fields not in known keys
   */
  getAdditionalFields(obj, knownKeys) {
    if (!obj || typeof obj !== 'object') return {};
    const knownSet = new Set(knownKeys);
    return Object.entries(obj)
      .filter(([key]) => !knownSet.has(key))
      .reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
      }, {});
  }

  /**
   * Validate that state has minimum required structure
   */
  validate(state) {
    const errors = [];

    if (!state.pods || state.pods.length === 0) {
      errors.push('No pods found in cluster state');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// Export singleton
module.exports = new ClusterStateAdapter();
