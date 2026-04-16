const http = require('http');

// Pod database with manual control flags
let pods = [
  { name: 'api-server', namespace: 'production', status: 'Running', cpu: 120, memory: 256, containers: [{ name: 'api-server', status: 'Running' }], replicas: 2 },
  { name: 'database-primary', namespace: 'databases', status: 'Running', cpu: 800, memory: 2048, containers: [{ name: 'postgres', status: 'Running' }], replicas: 1 },
  { name: 'cache-redis', namespace: 'middleware', status: 'Running', cpu: 150, memory: 512, containers: [{ name: 'redis', status: 'Running' }], replicas: 3 },
  { name: 'worker-1', namespace: 'jobs', status: 'Running', cpu: 200, memory: 512, containers: [{ name: 'worker', status: 'Running' }], replicas: 2 },
  { name: 'worker-2', namespace: 'jobs', status: 'Running', cpu: 180, memory: 480, containers: [{ name: 'worker', status: 'Running' }], replicas: 2 },
  { name: 'web-frontend', namespace: 'production', status: 'Running', cpu: 100, memory: 256, containers: [{ name: 'frontend', status: 'Running' }], replicas: 3 },
];

// Manual overrides (when user disconnects a service)
const manualOverrides = new Map();

// Auto-scenario cycling
let autoScenarioEnabled = false; // Disabled by default to let user control
let currentScenario = 0;

// Healing status tracking
let healingStatus = {
  active: false,
  lastAction: null,
  lastResult: null,
  history: []
};

// Load balancer state
let loadBalancer = {
  distribution: new Map(),
  lastRebalance: Date.now()
};

// Function to generate dynamic metrics
function generateDynamicMetrics() {
  const timeSlot = Math.floor(Date.now() / 5000);

  // Only apply auto-scenarios if enabled and no manual overrides
  if (autoScenarioEnabled && manualOverrides.size === 0) {
    currentScenario = timeSlot % 4;

    // Reset all pods to running first
    pods.forEach(pod => {
      pod.status = 'Running';
      pod.containers.forEach(c => c.status = 'Running');
    });

    // Apply scenario
    if (currentScenario === 0) {
      // Cache failure
      const cacheIdx = pods.findIndex(p => p.name === 'cache-redis');
      pods[cacheIdx].status = 'CrashLoopBackOff';
      pods[cacheIdx].cpu = 0;
      pods[cacheIdx].memory = 0;
      pods[cacheIdx].containers[0].status = 'CrashLoopBackOff';
    } else if (currentScenario === 1) {
      // Database failure
      const dbIdx = pods.findIndex(p => p.name === 'database-primary');
      pods[dbIdx].status = 'CrashLoopBackOff';
      pods[dbIdx].cpu = 0;
      pods[dbIdx].memory = 0;
      pods[dbIdx].containers[0].status = 'CrashLoopBackOff';

      const worker1Idx = pods.findIndex(p => p.name === 'worker-1');
      pods[worker1Idx].status = 'Failed';
      pods[worker1Idx].cpu = 0;
      pods[worker1Idx].memory = 0;
      pods[worker1Idx].containers[0].status = 'Error';
    } else if (currentScenario === 2) {
      // Worker failure
      const worker2Idx = pods.findIndex(p => p.name === 'worker-2');
      pods[worker2Idx].status = 'Pending';
      pods[worker2Idx].cpu = 0;
      pods[worker2Idx].memory = 0;
      pods[worker2Idx].containers[0].status = 'Waiting';
    }
    // Scenario 3: All healthy
  }

  // Apply manual overrides
  manualOverrides.forEach((override, podName) => {
    const pod = pods.find(p => p.name === podName);
    if (pod) {
      pod.status = override.status;
      pod.cpu = override.cpu;
      pod.memory = override.memory;
      pod.containers.forEach(c => c.status = override.containerStatus);
    }
  });

  // Generate alerts based on pod states
  const alerts = [];
  const failedPods = pods.filter(p => p.status !== 'Running');

  failedPods.forEach(pod => {
    let severity = 'warning';
    if (pod.status === 'CrashLoopBackOff' || pod.status === 'Failed') {
      severity = 'critical';
    }
    alerts.push({
      severity,
      message: `Pod ${pod.name} is in ${pod.status} state`,
      timestamp: new Date().toISOString(),
      pod: pod.name,
      namespace: pod.namespace
    });
  });

  // Check for resource exhaustion
  const highCpuPods = pods.filter(p => p.cpu > 400);
  const highMemoryPods = pods.filter(p => p.memory > 1500);

  if (highCpuPods.length > 0) {
    alerts.push({
      severity: 'warning',
      message: `High CPU usage detected on ${highCpuPods.map(p => p.name).join(', ')}`,
      timestamp: new Date().toISOString(),
      type: 'resource_exhaustion'
    });
  }

  if (highMemoryPods.length > 0) {
    alerts.push({
      severity: 'critical',
      message: `Memory pressure on ${highMemoryPods.map(p => p.name).join(', ')}`,
      timestamp: new Date().toISOString(),
      type: 'resource_exhaustion'
    });
  }

  // Add general cluster alerts
  const runningPods = pods.filter(p => p.status === 'Running').length;
  const failedPodCount = pods.filter(p => p.status === 'Failed' || p.status === 'CrashLoopBackOff').length;

  // Calculate resource usage
  const totalCpu = pods.reduce((sum, p) => sum + (p.status === 'Running' ? p.cpu : 0), 0);
  const totalMemory = pods.reduce((sum, p) => sum + (p.status === 'Running' ? p.memory : 0), 0);
  const maxCpu = pods.reduce((sum, p) => sum + (p.cpu > 0 ? p.cpu : 200), 0) || 1;
  const maxMemory = pods.reduce((sum, p) => sum + (p.memory > 0 ? p.memory : 500), 0) || 1;

  return {
    cluster: {
      name: 'production-cluster',
      status: failedPodCount > 0 ? 'unhealthy' : 'healthy',
      nodes: 5,
      pods_total: pods.length,
      pods_running: runningPods,
      pods_failed: failedPodCount,
    },
    resources: {
      cpu_usage_percent: Math.min(100, Math.round((totalCpu / maxCpu) * 100)),
      memory_usage_percent: Math.min(100, Math.round((totalMemory / maxMemory) * 100)),
      storage_usage_percent: 54,
    },
    nodes: [
      { name: 'node-1', cpu: 45, memory: 60, status: 'Ready' },
      { name: 'node-2', cpu: 72, memory: 85, status: 'Ready' },
      { name: 'node-3', cpu: 55, memory: 65, status: 'Ready' },
      { name: 'node-4', cpu: 78, memory: 70, status: 'NotReady' },
      { name: 'node-5', cpu: 68, memory: 75, status: 'Ready' },
    ],
    pods: pods,
    alerts: alerts,
    healing: healingStatus,
    autoScenarioEnabled: autoScenarioEnabled,
    manualOverrides: Array.from(manualOverrides.keys()),
    loadBalancer: {
      distribution: Object.fromEntries(loadBalancer.distribution),
      lastRebalance: loadBalancer.lastRebalance
    }
  };
}

// Kill a specific pod (simulate failure)
function killPod(podName, failureType = 'CrashLoopBackOff') {
  const pod = pods.find(p => p.name === podName);
  if (!pod) return { success: false, error: 'Pod not found' };

  const statuses = {
    'CrashLoopBackOff': { status: 'CrashLoopBackOff', cpu: 0, memory: 0, containerStatus: 'CrashLoopBackOff' },
    'Failed': { status: 'Failed', cpu: 0, memory: 0, containerStatus: 'Error' },
    'Pending': { status: 'Pending', cpu: 0, memory: 0, containerStatus: 'Waiting' },
    'OOMKilled': { status: 'OOMKilled', cpu: 10, memory: 512, containerStatus: 'Terminated' }
  };

  const config = statuses[failureType] || statuses['CrashLoopBackOff'];
  manualOverrides.set(podName, config);

  // Record healing history
  healingStatus.history.push({
    timestamp: new Date().toISOString(),
    action: 'kill',
    pod: podName,
    failureType: failureType
  });

  return {
    success: true,
    message: `Pod ${podName} is now ${failureType}`,
    pod: podName,
    status: failureType
  };
}

// Restart a pod with intelligent healing
function restartPod(podName) {
  const originalPod = pods.find(p => p.name === podName);
  if (!originalPod) return { success: false, error: 'Pod not found' };

  // Remove manual override
  manualOverrides.delete(podName);

  // Restore original values
  const originalSpecs = {
    'api-server': { cpu: 120, memory: 256 },
    'database-primary': { cpu: 800, memory: 2048 },
    'cache-redis': { cpu: 150, memory: 512 },
    'worker-1': { cpu: 200, memory: 512 },
    'worker-2': { cpu: 180, memory: 480 },
    'web-frontend': { cpu: 100, memory: 256 }
  };

  const specs = originalSpecs[podName];
  if (specs) {
    originalPod.status = 'Running';
    originalPod.cpu = specs.cpu;
    originalPod.memory = specs.memory;
    originalPod.containers.forEach(c => c.status = 'Running');
  }

  // Record healing history
  healingStatus.lastAction = {
    timestamp: new Date().toISOString(),
    type: 'restart',
    target: podName,
    reason: 'Manual restart initiated'
  };
  healingStatus.history.push(healingStatus.lastAction);

  return {
    success: true,
    message: `Pod ${podName} has been restarted and is now Running`,
    pod: podName,
    action: 'restart'
  };
}

// Stop a pod container (simulate graceful stop/failure)
function stopPod(podName) {
  const pod = pods.find(p => p.name === podName);
  if (!pod) return { success: false, error: 'Pod not found' };

  manualOverrides.set(podName, {
    status: 'Failed',
    cpu: 0,
    memory: 0,
    containerStatus: 'Stopped'
  });

  healingStatus.history.push({
    timestamp: new Date().toISOString(),
    action: 'stop',
    pod: podName,
    reason: 'Manual container stop initiated'
  });

  return {
    success: true,
    message: `Container for pod ${podName} has been stopped`,
    pod: podName,
    action: 'stop'
  };
}

// Scale a pod with intelligent resource management
function scalePod(podName, scaleFactor = 1.5) {
  const pod = pods.find(p => p.name === podName);
  if (!pod) return { success: false, error: 'Pod not found' };

  const oldCpu = pod.cpu;
  const oldMemory = pod.memory;

  // Allow both scale up and scale down while keeping minimum viable resources.
  const clampedFactor = Math.max(0.5, Math.min(scaleFactor, 2.5));
  pod.memory = Math.max(128, Math.round(pod.memory * clampedFactor));
  pod.cpu = Math.max(50, Math.round(pod.cpu * clampedFactor));
  if (clampedFactor >= 1) {
    pod.replicas = Math.min((pod.replicas || 1) + 1, 10); // Cap at 10 replicas
  } else {
    pod.replicas = Math.max((pod.replicas || 1) - 1, 1); // Keep at least one replica
  }

  // Distribute load
  distributeLoad(podName);

  // Record healing history
  healingStatus.lastAction = {
    timestamp: new Date().toISOString(),
    type: clampedFactor >= 1 ? 'scale_up' : 'scale_down',
    target: podName,
    oldResources: { cpu: oldCpu, memory: oldMemory },
    newResources: { cpu: pod.cpu, memory: pod.memory },
    replicas: pod.replicas,
    reason: clampedFactor >= 1 ? 'Scaling up for resource optimization' : 'Scaling down to reduce overprovisioning'
  };
  healingStatus.history.push(healingStatus.lastAction);

  return {
    success: true,
    message: `Pod ${podName} scaled ${clampedFactor >= 1 ? 'up' : 'down'} (CPU: ${pod.cpu}m, Memory: ${pod.memory}Mi, Replicas: ${pod.replicas})`,
    pod: podName,
    oldResources: { cpu: oldCpu, memory: oldMemory },
    newResources: { cpu: pod.cpu, memory: pod.memory },
    replicas: pod.replicas
  };
}

// Distribute load across pods intelligently
function distributeLoad(serviceName) {
  const servicePods = pods.filter(p => p.name.includes(serviceName) || p.namespace === serviceName);

  if (servicePods.length === 0) return;

  // Calculate average load
  const avgCpu = servicePods.reduce((sum, p) => sum + p.cpu, 0) / servicePods.length;
  const avgMemory = servicePods.reduce((sum, p) => sum + p.memory, 0) / servicePods.length;

  // Update load balancer distribution
  loadBalancer.distribution.set(serviceName, {
    pods: servicePods.map(p => p.name),
    avgCpu,
    avgMemory,
    distribution: 'balanced'
  });
  loadBalancer.lastRebalance = Date.now();

  return {
    service: serviceName,
    balancedPods: servicePods.length,
    avgResources: { cpu: avgCpu, memory: avgMemory }
  };
}

// Intelligent self-healing based on pod status
function performIntelligentHealing(targetPod = null) {
  const issues = [];
  const actions = [];

  // Check all pods or just the target
  const podsToCheck = targetPod ? pods.filter(p => p.name === targetPod) : pods;

  podsToCheck.forEach(pod => {
    // Determine the best healing action based on pod state
    if (pod.status === 'CrashLoopBackOff') {
      // CrashLoopBackOff usually needs restart
      actions.push({
        pod: pod.name,
        action: 'restart',
        reason: 'Pod is in CrashLoopBackOff - restart required',
        priority: 'high'
      });
    } else if (pod.status === 'OOMKilled') {
      // OOM needs scaling up resources
      actions.push({
        pod: pod.name,
        action: 'scale',
        reason: 'Out of memory - scaling resources',
        priority: 'critical'
      });
    } else if (pod.status === 'Failed') {
      // Failed pods need restart
      actions.push({
        pod: pod.name,
        action: 'restart',
        reason: 'Pod is in Failed state',
        priority: 'high'
      });
    } else if (pod.status === 'Pending') {
      // Pending might need resource adjustment
      actions.push({
        pod: pod.name,
        action: 'scale',
        reason: 'Pod stuck in Pending - resource adjustment',
        priority: 'medium'
      });
    }

    // Check resource pressure even if pod is running
    if (pod.status === 'Running') {
      if (pod.cpu > 400) {
        actions.push({
          pod: pod.name,
          action: 'scale',
          reason: 'High CPU usage detected',
          priority: 'medium'
        });
      }
      if (pod.memory > 1500) {
        actions.push({
          pod: pod.name,
          action: 'scale',
          reason: 'High memory usage detected',
          priority: 'high'
        });
      }
    }

    if (pod.status !== 'Running') {
      issues.push({
        pod: pod.name,
        status: pod.status,
        severity: pod.status === 'OOMKilled' ? 'critical' : 'high'
      });
    }
  });

  // Execute healing actions
  const results = [];
  actions.forEach(action => {
    let result;
    if (action.action === 'restart') {
      result = restartPod(action.pod);
    } else if (action.action === 'scale') {
      result = scalePod(action.pod);
    }
    if (result) {
      results.push({ ...action, result });
    }
  });

  // Update healing status
  healingStatus.active = false;
  healingStatus.lastResult = {
    timestamp: new Date().toISOString(),
    issuesFound: issues.length,
    actionsTaken: actions.length,
    results: results
  };

  return {
    success: true,
    issues: issues,
    actions: actions,
    results: results,
    message: `Healing complete: ${actions.length} actions taken for ${issues.length} issues`
  };
}

// Get cluster health summary
function getClusterHealth() {
  const metrics = generateDynamicMetrics();
  const failedPods = metrics.pods.filter(p => p.status !== 'Running');
  const resourceAlerts = metrics.alerts.filter(a => a.type === 'resource_exhaustion');

  return {
    overall: metrics.cluster.status,
    healthScore: calculateHealthScore(metrics),
    failedPods: failedPods.map(p => ({ name: p.name, status: p.status })),
    resourceAlerts: resourceAlerts.length,
    recommendations: generateRecommendations(metrics)
  };
}

// Calculate cluster health score
function calculateHealthScore(metrics) {
  let score = 100;

  // Deduct for failed pods
  score -= metrics.cluster.pods_failed * 15;

  // Deduct for resource usage
  if (metrics.resources.cpu_usage_percent > 80) score -= 10;
  if (metrics.resources.memory_usage_percent > 80) score -= 15;

  // Deduct for alerts
  const criticalAlerts = metrics.alerts.filter(a => a.severity === 'critical').length;
  score -= criticalAlerts * 10;

  return Math.max(0, Math.min(100, score));
}

// Generate recommendations based on cluster state
function generateRecommendations(metrics) {
  const recommendations = [];

  if (metrics.cluster.pods_failed > 0) {
    recommendations.push({
      type: 'urgent',
      message: `Restart ${metrics.cluster.pods_failed} failed pod(s)`,
      action: 'heal'
    });
  }

  if (metrics.resources.cpu_usage_percent > 80) {
    recommendations.push({
      type: 'warning',
      message: 'High CPU usage - consider scaling up',
      action: 'scale'
    });
  }

  if (metrics.resources.memory_usage_percent > 80) {
    recommendations.push({
      type: 'critical',
      message: 'Memory pressure detected - scaling recommended',
      action: 'scale'
    });
  }

  return recommendations;
}

const server = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /api/metrics - Get all metrics
  if (url.pathname === '/api/metrics' && req.method === 'GET') {
    const metrics = generateDynamicMetrics();
    res.writeHead(200);
    res.end(JSON.stringify(metrics, null, 2));
    return;
  }

  // GET /api/pods - Get all pods
  if (url.pathname === '/api/pods' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({ pods }, null, 2));
    return;
  }

  // GET /api/health - Get cluster health
  if (url.pathname === '/api/health' && req.method === 'GET') {
    const health = getClusterHealth();
    res.writeHead(200);
    res.end(JSON.stringify(health, null, 2));
    return;
  }

  // POST /api/pods/:name/kill - Kill a specific pod
  if (url.pathname.match(/\/api\/pods\/[^\/]+\/kill/) && req.method === 'POST') {
    const podName = url.pathname.split('/')[3];
    const failureType = url.searchParams.get('type') || 'CrashLoopBackOff';
    const result = killPod(podName, failureType);
    res.writeHead(result.success ? 200 : 404);
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  // POST /api/pods/:name/restart - Restart a specific pod
  if (url.pathname.match(/\/api\/pods\/[^\/]+\/restart/) && req.method === 'POST') {
    const podName = url.pathname.split('/')[3];
    const result = restartPod(podName);
    res.writeHead(result.success ? 200 : 404);
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  // POST /api/pods/:name/stop - Stop a specific pod container
  if (url.pathname.match(/\/api\/pods\/[^\/]+\/stop/) && req.method === 'POST') {
    const podName = url.pathname.split('/')[3];
    const result = stopPod(podName);
    res.writeHead(result.success ? 200 : 404);
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  // POST /api/pods/:name/scale - Scale a specific pod
  if (url.pathname.match(/\/api\/pods\/[^\/]+\/scale/) && req.method === 'POST') {
    const podName = url.pathname.split('/')[3];
    const scaleFactor = parseFloat(url.searchParams.get('factor')) || 1.5;
    const result = scalePod(podName, scaleFactor);
    res.writeHead(result.success ? 200 : 404);
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  // POST /api/heal - Trigger intelligent self-healing
  if (url.pathname === '/api/heal' && req.method === 'POST') {
    healingStatus.active = true;
    const targetPod = url.searchParams.get('pod');
    const result = performIntelligentHealing(targetPod);
    res.writeHead(200);
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  // POST /api/heal/auto - Enable/disable auto-healing
  if (url.pathname === '/api/heal/auto' && req.method === 'POST') {
    const enabled = url.searchParams.get('enabled') === 'true';
    // Auto-healing logic would go here
    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      autoHealEnabled: enabled,
      message: enabled ? 'Auto-healing enabled' : 'Auto-healing disabled'
    }, null, 2));
    return;
  }

  // POST /api/control/auto-scenario - Toggle auto-scenarios
  if (url.pathname === '/api/control/auto-scenario' && req.method === 'POST') {
    autoScenarioEnabled = !autoScenarioEnabled;
    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      autoScenarioEnabled,
      message: autoScenarioEnabled ? 'Auto-scenarios enabled' : 'Auto-scenarios disabled'
    }, null, 2));
    return;
  }

  // POST /api/control/reset - Reset all manual overrides
  if (url.pathname === '/api/control/reset' && req.method === 'POST') {
    manualOverrides.clear();
    pods.forEach(pod => {
      pod.status = 'Running';
      pod.containers.forEach(c => c.status = 'Running');
    });
    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      message: 'All pods reset to Running state'
    }, null, 2));
    return;
  }

  // GET /api/heal/history - Get healing history
  if (url.pathname === '/api/heal/history' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({
      history: healingStatus.history.slice(-20), // Last 20 entries
      lastAction: healingStatus.lastAction,
      lastResult: healingStatus.lastResult
    }, null, 2));
    return;
  }

  // GET / - Health check
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      message: 'Mock Metrics API with Intelligent Self-Healing',
      features: [
        'Service Kill/Restart/Scale',
        'Intelligent Auto-Healing',
        'Load Distribution',
        'Health Scoring',
        'Recommendations'
      ],
      endpoints: [
        'GET  /api/metrics',
        'GET  /api/pods',
        'GET  /api/health',
        'POST /api/pods/:name/kill?type=CrashLoopBackOff|Failed|Pending|OOMKilled',
        'POST /api/pods/:name/stop',
        'POST /api/pods/:name/restart',
        'POST /api/pods/:name/scale?factor=1.5',
        'POST /api/heal?pod=<name>',
        'POST /api/heal/auto?enabled=true|false',
        'GET  /api/heal/history',
        'POST /api/control/auto-scenario',
        'POST /api/control/reset'
      ]
    }, null, 2));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not Found' }));
});

const PORT = 5555;
server.listen(PORT, () => {
  console.log(`\n🚀 Intelligent Mock Metrics API running on http://localhost:${PORT}`);
  console.log(`📊 Metrics endpoint: http://localhost:${PORT}/api/metrics`);
  console.log(`🏥 Health endpoint: http://localhost:${PORT}/api/health`);
  console.log(`\n🔧 Service Control endpoints:`);
  console.log(`   POST /api/pods/:name/kill?type=CrashLoopBackOff|Failed|Pending|OOMKilled`);
  console.log(`   POST /api/pods/:name/stop`);
  console.log(`   POST /api/pods/:name/restart`);
  console.log(`   POST /api/pods/:name/scale?factor=1.5`);
  console.log(`\n🤖 Self-Healing endpoints:`);
  console.log(`   POST /api/heal?pod=<name> (heal specific pod or all if no pod specified)`);
  console.log(`   POST /api/heal/auto?enabled=true|false`);
  console.log(`   GET  /api/heal/history`);
  console.log(`   POST /api/control/reset`);
  console.log(`\n💡 Features: Auto-scaling, Load Distribution, Health Scoring, Intelligent Remediation`);
});
