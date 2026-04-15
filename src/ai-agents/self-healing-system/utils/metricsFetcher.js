/**
 * Metrics Fetcher
 * Fetches real-time metrics from external endpoints (e.g., ngrok)
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('./logger');

class MetricsFetcher {
  constructor() {
    this.metricsUrl = process.env.METRICS_URL || '';
    this.lastFetch = null;
    this.cache = null;
    this.cacheTTL = 0; // No caching - always fetch fresh
    this.forceRefresh = true; // Always get fresh data
  }

  /**
   * Set the metrics endpoint URL
   */
  setMetricsUrl(url) {
    this.metricsUrl = url;
    this.cache = null; // Clear cache when URL changes
    this.lastFetch = null;
    logger.info(`🔄 Metrics URL set to: ${url} (real-time refresh enabled)`);
  }

  /**
   * Force refresh - bypass cache
   */
  forceRefreshData() {
    this.cache = null;
    this.lastFetch = null;
  }

  /**
   * Fetch metrics from the configured endpoint
   */
  async fetchMetrics(skipCache = true) {
    if (!this.metricsUrl) {
      throw new Error('Metrics URL not configured. Set METRICS_URL environment variable.');
    }

    // Skip cache for real-time data (default behavior)
    if (!skipCache && this.cache && this.lastFetch && (Date.now() - this.lastFetch) < this.cacheTTL) {
      logger.debug('🔄 Using recent cached metrics');
      return this.cache;
    }

    try {
      logger.info(`📥 Fetching fresh metrics from: ${this.metricsUrl}`);
      const data = await this.makeRequest(this.metricsUrl);

      // Log raw data received
      const isArray = Array.isArray(data);
      const itemCount = isArray ? data.length : (data.pods ? data.pods.length : Object.keys(data).length);
      logger.debug(`✓ Raw data received: ${isArray ? 'array' : typeof data} with ${itemCount} items`);

      // Parse and normalize the response
      const normalized = this.normalizeMetrics(data);

      // Update cache
      this.cache = normalized;
      this.lastFetch = Date.now();

      const podCount = normalized.pods?.length || 0;
      logger.info(`✅ Real-time metrics fetched (${podCount} pods normalized)`);
      return normalized;
    } catch (error) {
      logger.error('❌ Failed to fetch metrics:', error.message);
      throw error;
    }
  }

  /**
   * Make HTTP/HTTPS request
   */
  makeRequest(urlString) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const client = url.protocol === 'https:' ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Self-Healing-System/1.0',
          'ngrok-skip-browser-warning': '1'
        },
        timeout: 10000 // 10 second timeout
      };

      const req = client.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const parsed = JSON.parse(data);
              resolve(parsed);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`Request failed: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });
  }

  /**
   * Normalize metrics from various formats to internal format
   */
  normalizeMetrics(data) {
    // Handle different response formats
    if (!data) {
      return this.createEmptyState();
    }

    // Handle ngrok /pods endpoint format with collection wrapper (real K8s data)
    if (data.pods && Array.isArray(data.pods) && data.collection) {
      logger.info(`🔗 Detected ngrok K8s format: ${data.pods.length} pods`);
      return {
        timestamp: new Date().toISOString(),
        source: 'ngrok-k8s',
        nodes: [],
        pods: data.pods.map(pod => this.normalizeNgrokPod(pod)),
        services: this.extractServicesFromPods(data.pods),
        metrics: {},
        logs: [],
        raw: data
      };
    }

    // Handle ngrok /pods endpoint format (returns array directly)
    if (Array.isArray(data)) {
      logger.info(`🔗 Detected ngrok pods format: ${data.length} pods received`);
      return {
        timestamp: new Date().toISOString(),
        source: 'ngrok-pods',
        nodes: [],
        pods: data.map(pod => this.normalizePod(pod)),
        services: [],
        metrics: {},
        logs: [],
        raw: data
      };
    }

    // If data is already in our format, use it
    if (data.pods && Array.isArray(data.pods)) {
      logger.info(`📊 Detected structured format: ${data.pods.length} pods`);
      return {
        timestamp: data.timestamp || new Date().toISOString(),
        source: 'external',
        nodes: data.nodes || [],
        pods: data.pods.map(pod => this.normalizePod(pod)),
        services: data.services || [],
        metrics: data.metrics || {},
        logs: data.logs || [],
        raw: data
      };
    }

    // Handle Kubernetes-style metrics format
    if (data.items && Array.isArray(data.items)) {
      logger.info(`☸️  Detected Kubernetes format: ${data.items.length} items`);
      return {
        timestamp: new Date().toISOString(),
        source: 'kubernetes',
        nodes: [],
        pods: data.items.map(item => this.normalizeK8sPod(item)),
        services: [],
        metrics: {},
        logs: [],
        raw: data
      };
    }

    // Handle Prometheus-style format
    if (data.status === 'success' && data.data) {
      logger.info('📈 Detected Prometheus format');
      return this.normalizePrometheus(data.data);
    }

    // Generic fallback - try to extract what we can
    logger.warn('⚠️  Using generic format detection for metrics');
    return {
      timestamp: new Date().toISOString(),
      source: 'unknown',
      nodes: data.nodes || [],
      pods: data.pods || data.containers || [],
      services: data.services || [],
      metrics: data.metrics || data.stats || {},
      logs: data.logs || [],
      raw: data
    };
  }

  /**
   * Normalize ngrok K8s pod format
   */
  normalizeNgrokPod(pod) {
    const containers = pod.container_health?.containers || [];
    const mainContainer = containers[0] || {};

    // Extract status from container state
    let status = pod.status || 'Unknown';
    let phase = pod.status || 'Unknown';

    // Check container state for more accurate status
    if (mainContainer.state) {
      if (mainContainer.state.waiting) {
        status = `Waiting: ${mainContainer.state.waiting.reason || 'Unknown'}`;
        phase = 'Pending';
      } else if (mainContainer.state.terminated) {
        status = `Terminated: ${mainContainer.state.terminated.reason || 'Unknown'}`;
        phase = 'Failed';
      }
    }

    // Check for recent terminations/restarts
    const lastState = mainContainer.last_state?.terminated;
    const hasError = lastState && lastState.reason === 'Error';
    const exitCode = lastState?.exitCode || 0;

    // Extract dependencies from services
    const dependencies = [];
    const services = pod.networking?.services || [];
    services.forEach(svc => {
      dependencies.push({
        type: 'service',
        name: svc.name,
        target: svc.cluster_ip,
        source: 'kubernetes-service'
      });
    });

    // Infer dependencies from labels
    const labels = pod.identity?.labels || {};
    const appName = labels.app || '';

    // Infer database/cache dependencies based on app name patterns
    if (appName.includes('cart') || appName.includes('checkout') || appName.includes('order')) {
      dependencies.push({ type: 'cache', name: 'redis-cart', target: 'redis-cart', source: 'inferred' });
    }
    if (appName.includes('checkout') || appName.includes('payment')) {
      dependencies.push({ type: 'service', name: 'paymentservice', target: 'paymentservice', source: 'inferred' });
    }

    return {
      name: this.normalizeWorkloadName(pod.name || 'unknown'),
      namespace: pod.namespace || 'default',
      status: status,
      phase: phase,
      cpu: 0, // No metrics available from this endpoint
      memory: 0,
      restarts: pod.restart_count || 0,
      ready: pod.ready || false,
      labels: labels,
      annotations: pod.identity?.annotations || {},
      serviceAccount: pod.identity?.service_account || '',
      uid: pod.identity?.uid || '',
      nodeName: pod.placement?.node_name || '',
      podIP: pod.networking?.pod_ip || '',
      conditions: pod.lifecycle?.conditions || [],
      containers: containers.map(c => ({
        name: c.name,
        image: c.image,
        ready: c.ready,
        restartCount: c.restart_count,
        state: c.state,
        waitingReason: c.waiting_reason,
        waitingMessage: c.waiting_message,
        lastState: c.last_state
      })),
      events: pod.events || {},
      dependencies: dependencies,
      hasError: hasError,
      exitCode: exitCode,
      age: pod.age || ''
    };
  }

  /**
   * Extract services from pods data
   */
  extractServicesFromPods(pods) {
    const services = [];
    const seen = new Set();

    pods.forEach(pod => {
      const svcList = pod.networking?.services || [];
      svcList.forEach(svc => {
        if (!seen.has(svc.name)) {
          seen.add(svc.name);
          services.push({
            name: svc.name,
            namespace: pod.namespace || 'default',
            type: svc.type || 'ClusterIP',
            clusterIP: svc.cluster_ip || '',
            ports: svc.ports || [],
            endpoints: [pod.name]
          });
        }
      });
    });

    return services;
  }

  /**
   * Normalize a single pod
   */
  normalizePod(pod) {
    // Extract dependencies from env vars or connections
    const dependencies = pod.dependencies || [];

    // Parse env vars for dependencies
    const env = pod.env || pod.environment || {};
    Object.entries(env).forEach(([key, value]) => {
      if (key.includes('HOST') || key.includes('URL') || key.includes('SERVICE')) {
        dependencies.push({
          type: this.classifyDependency(key),
          name: key,
          target: value,
          source: 'env'
        });
      }
    });

    // Also check connections if available
    if (pod.connections) {
      pod.connections.forEach(conn => {
        if (!dependencies.some(d => d.target === conn.target)) {
          dependencies.push({
            type: conn.type || 'connection',
            name: conn.name || 'connection',
            target: conn.target,
            source: 'connection'
          });
        }
      });
    }

    return {
      name: this.normalizeWorkloadName(pod.name || pod.podName || pod.id || 'unknown'),
      namespace: pod.namespace || 'default',
      status: pod.status || pod.phase || pod.state || 'Unknown',
      phase: pod.phase || pod.status || 'Unknown',
      cpu: this.parseMetric(pod.cpu || pod.cpuUsage),
      memory: this.parseMetric(pod.memory || pod.memoryUsage),
      restarts: parseInt(pod.restarts || pod.restartCount) || 0,
      ready: pod.ready !== undefined ? pod.ready : true,
      labels: pod.labels || pod.metadata?.labels || {},
      env: env,
      dependencies: dependencies,
      logs: pod.logs || [],
      nodeName: pod.nodeName || pod.node || '',
      conditions: pod.conditions || []
    };
  }

  /**
   * Normalize Kubernetes-style pod
   */
  normalizeK8sPod(item) {
    const pod = item;
    const metadata = pod.metadata || {};
    const spec = pod.spec || {};
    const status = pod.status || {};

    // Calculate CPU/Memory usage if available
    let cpu = 0;
    let memory = 0;

    if (status.containerStatuses) {
      status.containerStatuses.forEach(container => {
        // Try to get from resources or use defaults
        const resources = container.resources || {};
        const usage = resources.usage || {};
        if (usage.cpu) cpu += this.parseCpu(usage.cpu);
        if (usage.memory) memory += this.parseMemory(usage.memory);
      });
    }

    // Extract dependencies from env
    const dependencies = [];
    if (spec.containers && spec.containers[0] && spec.containers[0].env) {
      spec.containers[0].env.forEach(env => {
        if (env.value && (env.name.includes('HOST') || env.name.includes('URL') || env.name.includes('SERVICE'))) {
          dependencies.push({
            type: this.classifyDependency(env.name),
            name: env.name,
            target: env.value,
            source: 'env'
          });
        }
      });
    }

    return {
      name: this.normalizeWorkloadName(metadata.name || 'unknown'),
      namespace: metadata.namespace || 'default',
      status: status.phase || 'Unknown',
      phase: status.phase || 'Unknown',
      cpu: cpu,
      memory: memory,
      restarts: status.containerStatuses?.[0]?.restartCount || 0,
      ready: status.containerStatuses?.[0]?.ready || false,
      labels: metadata.labels || {},
      env: this.extractEnv(spec.containers?.[0]?.env),
      dependencies: dependencies,
      logs: [],
      nodeName: spec.nodeName || '',
      conditions: status.conditions || []
    };
  }

  /**
   * Normalize Prometheus data
   */
  normalizePrometheus(data) {
    // Convert Prometheus result to our format
    const pods = [];

    if (data.result && Array.isArray(data.result)) {
      data.result.forEach(metric => {
        const labels = metric.metric || {};
        const value = metric.value || [0, '0'];

        pods.push({
          name: labels.pod || labels.name || 'unknown',
          namespace: labels.namespace || 'default',
          status: 'Running',
          cpu: parseFloat(value[1]) || 0,
          memory: 0,
          restarts: 0,
          ready: true,
          labels: labels
        });
      });
    }

    return {
      timestamp: new Date().toISOString(),
      source: 'prometheus',
      nodes: [],
      pods: pods,
      services: [],
      metrics: {},
      logs: [],
      raw: data
    };
  }

  /**
   * Parse CPU string to percentage
   */
  parseCpu(cpuStr) {
    if (!cpuStr) return 0;
    if (typeof cpuStr === 'number') return cpuStr;

    // Handle "100m" format (millicores)
    if (cpuStr.endsWith('m')) {
      return parseInt(cpuStr) / 10;
    }

    // Handle "100Mi" format
    if (cpuStr.endsWith('Mi')) {
      return parseInt(cpuStr);
    }

    return parseFloat(cpuStr) || 0;
  }

  /**
   * Parse memory string to MB
   */
  parseMemory(memStr) {
    if (!memStr) return 0;
    if (typeof memStr === 'number') return memStr;

    const units = {
      'Ki': 1/1024,
      'Mi': 1,
      'Gi': 1024,
      'Ti': 1024 * 1024
    };

    for (const [unit, factor] of Object.entries(units)) {
      if (memStr.endsWith(unit)) {
        return parseInt(memStr) * factor;
      }
    }

    return parseFloat(memStr) || 0;
  }

  /**
   * Strip presentation suffixes from workload names.
   */
  normalizeWorkloadName(name) {
    return String(name || '').replace(/\s*\(deployment\)\s*$/i, '').trim();
  }

  /**
   * Parse metric value
   */
  parseMetric(value) {
    if (typeof value === 'number') return value;
    if (!value) return 0;

    // Handle percentage strings
    if (typeof value === 'string') {
      if (value.endsWith('%')) {
        return parseFloat(value);
      }
      return parseFloat(value) || 0;
    }

    return 0;
  }

  /**
   * Classify dependency type
   */
  classifyDependency(name) {
    const lower = name.toLowerCase();
    if (lower.includes('db') || lower.includes('database') || lower.includes('postgres')) return 'database';
    if (lower.includes('redis') || lower.includes('cache')) return 'cache';
    if (lower.includes('kafka') || lower.includes('queue')) return 'queue';
    if (lower.includes('api') || lower.includes('service')) return 'service';
    return 'unknown';
  }

  /**
   * Extract env variables
   */
  extractEnv(envArray) {
    if (!Array.isArray(envArray)) return {};

    const env = {};
    envArray.forEach(e => {
      if (e.name && e.value) {
        env[e.name] = e.value;
      }
    });
    return env;
  }

  /**
   * Create empty state
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
      events: []
    };
  }

  /**
   * Get fetch status
   */
  getStatus() {
    return {
      url: this.metricsUrl,
      lastFetch: this.lastFetch,
      cacheValid: this.cache && this.lastFetch && (Date.now() - this.lastFetch) < this.cacheTTL
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache = null;
    this.lastFetch = null;
  }
}

// Export singleton
module.exports = new MetricsFetcher();
