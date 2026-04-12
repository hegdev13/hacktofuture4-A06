const http = require('http');

// Function to generate dynamic metrics based on time
function generateDynamicMetrics() {
  // Use time to create pseudo-random state (changes every 5 seconds)
  const timeSlot = Math.floor(Date.now() / 5000);
  
  // Simulate different failure scenarios - 4 scenarios cycling
  let failureScenario = timeSlot % 4;
  
  let pods = [
    { name: 'api-server', namespace: 'production', status: 'Running', cpu: 120, memory: 256 },
    { name: 'database-primary', namespace: 'databases', status: 'Running', cpu: 800, memory: 2048 },
    { name: 'cache-redis', namespace: 'middleware', status: 'Running', cpu: 150, memory: 512 },
    { name: 'worker-1', namespace: 'jobs', status: 'Running', cpu: 200, memory: 512 },
    { name: 'worker-2', namespace: 'jobs', status: 'Running', cpu: 180, memory: 480 },
    { name: 'web-frontend', namespace: 'production', status: 'Running', cpu: 100, memory: 256 },
  ];
  
  let alerts = [];
  let failed_pod_count = 0;
  
  // Scenario 0: Cache failure (most common)
  if (failureScenario === 0) {
    const cacheIdx = pods.findIndex(p => p.name === 'cache-redis');
    pods[cacheIdx].status = 'CrashLoopBackOff';
    pods[cacheIdx].cpu = 0;
    pods[cacheIdx].memory = 0;
    
    // Cache down means dependent pods fail
    const worker1Idx = pods.findIndex(p => p.name === 'worker-1');
    pods[worker1Idx].status = 'Failed';
    pods[worker1Idx].cpu = 0;
    pods[worker1Idx].memory = 0;
    
    alerts.push(
      { severity: 'critical', message: 'Cache pod is in CrashLoopBackOff', timestamp: new Date().toISOString() },
      { severity: 'warning', message: 'Worker pod worker-1 failed due to dependency', timestamp: new Date().toISOString() }
    );
    failed_pod_count = 2;
  }
  // Scenario 1: Database connection issue
  else if (failureScenario === 1) {
    const dbIdx = pods.findIndex(p => p.name === 'database-primary');
    pods[dbIdx].status = 'CrashLoopBackOff';
    pods[dbIdx].cpu = 0;
    pods[dbIdx].memory = 0;
    
    // All workers fail if DB is down
    const worker1Idx = pods.findIndex(p => p.name === 'worker-1');
    const worker2Idx = pods.findIndex(p => p.name === 'worker-2');
    pods[worker1Idx].status = 'Failed';
    pods[worker2Idx].status = 'Failed';
    pods[worker1Idx].cpu = 0;
    pods[worker1Idx].memory = 0;
    pods[worker2Idx].cpu = 0;
    pods[worker2Idx].memory = 0;
    
    alerts.push(
      { severity: 'critical', message: 'Database pod database-primary is in CrashLoopBackOff', timestamp: new Date().toISOString() },
      { severity: 'critical', message: 'Multiple worker pods failed due to database dependency', timestamp: new Date().toISOString() }
    );
    failed_pod_count = 3;
  }
  // Scenario 2: Light failure - just one worker
  else if (failureScenario === 2) {
    const worker2Idx = pods.findIndex(p => p.name === 'worker-2');
    pods[worker2Idx].status = 'Pending';
    pods[worker2Idx].cpu = 0;
    pods[worker2Idx].memory = 0;
    
    alerts.push(
      { severity: 'warning', message: 'Worker pod worker-2 is pending', timestamp: new Date().toISOString() }
    );
    failed_pod_count = 1;
  }
  // Scenario 3: All healthy
  else {
    alerts.push(
      { severity: 'info', message: 'All pods running normally', timestamp: new Date().toISOString() }
    );
    failed_pod_count = 0;
  }
  
  // Add general alerts
  alerts.push(
    { severity: 'warning', message: 'Node node-4 is not ready', timestamp: new Date().toISOString() },
    { severity: 'warning', message: 'High memory usage on node-2 (85%)', timestamp: new Date().toISOString() }
  );
  
  const running_pods = pods.filter(p => p.status === 'Running').length;
  
  return {
    cluster: {
      name: 'production-cluster',
      status: failed_pod_count > 1 ? 'unhealthy' : 'healthy',
      nodes: 5,
      pods_total: pods.length,
      pods_running: running_pods,
      pods_failed: failed_pod_count,
    },
    resources: {
      cpu_usage_percent: 68,
      memory_usage_percent: 72,
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
  };
}

const server = http.createServer((req, res) => {
  // Enable CORS with proper headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/api/metrics' && req.method === 'GET') {
    const dynamicMetrics = generateDynamicMetrics();
    res.writeHead(200);
    res.end(JSON.stringify(dynamicMetrics, null, 2));
  } else if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', message: 'Mock Metrics API running' }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

const PORT = 5555;
server.listen(PORT, () => {
  console.log(`\n🚀 Mock Metrics API running on http://localhost:${PORT}`);
  console.log(`📊 Metrics endpoint: http://localhost:${PORT}/api/metrics\n`);
  console.log('Forwarding with ngrok...');
});
