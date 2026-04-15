const http = require('http');
const { analyzeMetrics } = require('../rca-agent');

/**
 * RCA API Server
 * Exposes RCA analysis endpoint for the frontend
 */

const PORT = 5556;

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    if (req.url === '/api/rca/analyze') {
      // Fetch real metrics
      const metricsData = await fetchMetrics();
      
      // Run RCA analysis
      const rcaAnalysis = analyzeMetrics(metricsData);
      
      // Enrich pods with RCA data
      const enrichedPods = enrichPodsWithRCA(metricsData.pods, rcaAnalysis);
      
      const response = {
        timestamp: new Date().toISOString(),
        status: rcaAnalysis.status,
        summary: rcaAnalysis.summary,
        healthPercent: calculateHealthPercent(enrichedPods),
        rootCauses: rcaAnalysis.rootCauses.map(rc => ({
          name: rc.name,
          status: rc.status,
          message: rc.message,
          failureType: 'root-cause'
        })),
        pods: enrichedPods,
        remediations: rcaAnalysis.remediations,
        analysis: {
          totalPods: metricsData.pods.length,
          failedCount: metricsData.pods.filter(p => p.status !== 'Running').length,
          rootCausesCount: rcaAnalysis.rootCauses.length,
          affectedCount: rcaAnalysis.affectedPods.length,
          dependencyChains: rcaAnalysis.dependencyChains
        }
      };
      
      res.writeHead(200);
      res.end(JSON.stringify(response, null, 2));
    } else if (req.url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', service: 'RCA Server' }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (error) {
    console.error('Error:', error);
    res.writeHead(500);
    res.end(JSON.stringify({ error: error.message }));
  }
});

/**
 * Fetch metrics from the metrics server
 */
async function fetchMetrics() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 5555,
      path: '/api/metrics',
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Enrich pods with RCA metadata
 */
function enrichPodsWithRCA(pods, rcaAnalysis) {
  const POD_DEPENDENCIES = {
    'api-server': ['cache-redis', 'database-primary'],
    'database-primary': [],
    'cache-redis': ['database-primary'],
    'worker-1': ['cache-redis', 'database-primary'],
    'worker-2': ['cache-redis', 'database-primary'],
    'web-frontend': ['api-server', 'worker-1'],
    'monitoring-agent': ['api-server'],
    'log-aggregator': ['database-primary'],
  };

  return pods.map(pod => {
    const isRootCause = rcaAnalysis.rootCauses.some(r => r.name === pod.name);
    const isAffected = rcaAnalysis.affectedPods.includes(pod.name);
    
    let failureType = 'healthy';
    let failureReason = null;

    if (isRootCause) {
      failureType = 'root-cause';
      failureReason = 'Original failure point - this pod must be recovered first';
    } else if (isAffected) {
      failureType = 'cascading';
      const deps = POD_DEPENDENCIES[pod.name] || [];
      const failedDep = deps.find(depName => 
        rcaAnalysis.rootCauses.some(rc => rc.name === depName)
      );
      if (failedDep) {
        failureReason = `Failed because ${failedDep} is down`;
      }
    }

    return {
      id: pod.name,
      name: pod.name,
      namespace: pod.namespace || 'default',
      status: pod.status === 'Running' ? 'running' : pod.status === 'CrashLoopBackOff' ? 'failed' : pod.status === 'Failed' ? 'failed' : 'pending',
      cpu: pod.cpu || 0,
      memory: pod.memory || 0,
      failureType,
      failureReason,
      dependencies: POD_DEPENDENCIES[pod.name] || [],
      dependents: Object.entries(POD_DEPENDENCIES)
        .filter(([_, deps]) => deps.includes(pod.name))
        .map(([name]) => name)
    };
  });
}

/**
 * Calculate health percentage
 */
function calculateHealthPercent(pods) {
  const healthy = pods.filter(p => p.failureType === 'healthy').length;
  return Math.round((healthy / pods.length) * 100);
}

server.listen(PORT, () => {
  console.log(`✅ RCA Server listening on port ${PORT}`);
  console.log(`   📊 RCA Analysis: http://localhost:${PORT}/api/rca/analyze`);
  console.log(`   💓 Health Check: http://localhost:${PORT}/health`);
});
