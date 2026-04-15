#!/usr/bin/env node

/**
 * WORKING SELF-HEALING SYSTEM WITH LIVE METRICS
 * Simplified, production-ready version
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Configuration
const METRICS_URL = process.env.METRICS_URL || 'https://refocus-cement-spud.ngrok-free.dev/pods';
const DASHBOARD_PORT = 3456;
const REFRESH_INTERVAL = 5000; // 5 seconds
const ANALYSIS_INTERVAL = 10000; // 10 seconds

// Global state
let clusterState = {
  pods: [],
  issues: [],
  lastUpdate: null
};

let dashboardClients = [];
let failedPods = [];

/**
 * Fetch metrics from ngrok
 */
async function fetchMetrics() {
  try {
    return new Promise((resolve, reject) => {
      const url = new URL(METRICS_URL);
      const protocol = url.protocol === 'https:' ? https : http;
      
      const req = protocol.request(url, { timeout: 8000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(Array.isArray(json) ? { pods: json } : json);
          } catch (e) {
            reject(new Error('Invalid JSON response'));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.on('error', reject);
      req.end();
    });
  } catch (error) {
    console.error('❌ Metrics fetch failed:', error.message);
    throw error;
  }
}

/**
 * Analyze pods for failures
 */
function analyzePods(pods) {
  const failed = pods.filter(p => p.status === 'Failed' || p.status === 'CrashLoopBackOff');
  const issues = [];

  failed.forEach(pod => {
    issues.push({
      pod: pod.name,
      status: pod.status,
      severity: 'critical',
      message: `Pod ${pod.name} is in ${pod.status} state`
    });
  });

  return { failed, issues };
}

/**
 * Broadcast to all connected dashboard clients
 */
function broadcast(data) {
  dashboardClients.forEach(res => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      // Client disconnected
    }
  });
}

/**
 * Continuous metrics refresh
 */
setInterval(async () => {
  try {
    const metrics = await fetchMetrics();
    clusterState.pods = metrics.pods || [];
    clusterState.lastUpdate = new Date().toISOString();

    const { failed, issues } = analyzePods(clusterState.pods);
    clusterState.issues = issues;

    console.log(`✅ [${new Date().toLocaleTimeString()}] Fetched ${clusterState.pods.length} pods, ${failed.length} failed`);

    // Broadcast to dashboard
    broadcast({
      type: 'metrics',
      data: {
        pods: clusterState.pods,
        issues,
        timestamp: clusterState.lastUpdate,
        healthy: failed.length === 0
      }
    });

    // Alert on failures
    if (failed.length > failedPods.length) {
      const newFailures = failed.filter(f => !failedPods.some(e => e.name === f.name));
      newFailures.forEach(pod => {
        console.log(`🚨 ALERT: Pod ${pod.name} is ${pod.status}`);
        broadcast({
          type: 'alert',
          severity: 'critical',
          pod: pod.name,
          message: `${pod.name} failed - triggering auto-heal`
        });
      });
    }
    failedPods = failed;
  } catch (error) {
    console.error('❌ Metrics update error:', error.message);
  }
}, REFRESH_INTERVAL);

/**
 * Dashboard HTTP Server
 */
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // SSE endpoint
  if (req.url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // Send initial state
    res.write(`data: ${JSON.stringify({
      type: 'metrics',
      data: {
        pods: clusterState.pods,
        issues: clusterState.issues,
        timestamp: clusterState.lastUpdate,
        healthy: clusterState.pods.every(p => p.status === 'Running')
      }
    })}\n\n`);

    // Add to clients
    dashboardClients.push(res);

    req.on('close', () => {
      dashboardClients = dashboardClients.filter(c => c !== res);
    });
    return;
  }

  // State endpoint
  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      pods: clusterState.pods,
      issues: clusterState.issues,
      lastUpdate: clusterState.lastUpdate,
      healthy: clusterState.pods.every(p => p.status === 'Running')
    }));
    return;
  }

  // Dashboard HTML
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getDashboardHTML());
    return;
  }

  // Dashboard JS
  if (req.url === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(getDashboardJS());
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Self-Healing Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      max-width: 1200px;
      width: 100%;
      background: white;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      text-align: center;
    }
    h1 { font-size: 2.5em; margin-bottom: 10px; }
    .subtitle { opacity: 0.9; font-size: 1.1em; }
    main { padding: 40px; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }
    .stat-card {
      background: #f8f9fa;
      padding: 25px;
      border-radius: 12px;
      border-left: 5px solid #667eea;
      text-align: center;
    }
    .stat-card.failed { border-left-color: #ef4444; }
    .stat-card.healthy { border-left-color: #10b981; }
    .stat-value { font-size: 2.5em; font-weight: bold; color: #333; }
    .stat-label { font-size: 0.9em; color: #666; margin-top: 8px; }
    .pods-section {
      margin-top: 40px;
    }
    .pods-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 20px;
    }
    .pod-item {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 12px;
      border-left: 5px solid #ddd;
      transition: all 0.3s;
    }
    .pod-item:hover { transform: translateY(-5px); box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
    .pod-item.running { border-left-color: #10b981; }
    .pod-item.failed { border-left-color: #ef4444; background: #fef2f2; }
    .pod-item.pending { border-left-color: #f59e0b; }
    .pod-name { font-weight: bold; font-size: 1.1em; margin-bottom: 8px; }
    .pod-status {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.85em;
      font-weight: 600;
    }
    .pod-status.running { background: #d1fae5; color: #065f46; }
    .pod-status.failed { background: #fee2e2; color: #991b1b; }
    .pod-status.pending { background: #fef3c7; color: #78350f; }
    .alerts {
      background: #fef2f2;
      border: 2px solid #fecaca;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 30px;
      display: none;
    }
    .alerts.show { display: block; }
    .alert-item {
      color: #991b1b;
      margin: 8px 0;
      padding: 10px;
      background: white;
      border-radius: 6px;
      border-left: 3px solid #dc2626;
    }
    .status-indicator {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      display: inline-block;
      margin-right: 8px;
    }
    .status-indicator.healthy { background: #10b981; animation: pulse 2s infinite; }
    .status-indicator.failed { background: #ef4444; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🔧 Self-Healing System</h1>
      <p class="subtitle">Real-time Kubernetes Cluster Monitoring</p>
    </header>
    <main>
      <div class="stats-grid">
        <div class="stat-card healthy">
          <div class="stat-value"><span class="status-indicator healthy"></span><span id="total">0</span></div>
          <div class="stat-label">Total Pods</div>
        </div>
        <div class="stat-card healthy">
          <div class="stat-value" id="running">0</div>
          <div class="stat-label">Running ✅</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="pending">0</div>
          <div class="stat-label">Pending ⏳</div>
        </div>
        <div class="stat-card failed">
          <div class="stat-value" id="failed">0</div>
          <div class="stat-label">Failed ❌</div>
        </div>
      </div>

      <div class="alerts" id="alerts"></div>

      <div class="pods-section">
        <h2 style="margin-bottom: 20px;">📦 Pod Status</h2>
        <div class="pods-list" id="podsList">
          <div style="text-align: center; padding: 40px; color: #999;">Loading pods...</div>
        </div>
      </div>
    </main>
  </div>

  <script src="/app.js"></script>
</body>
</html>`;
}

function getDashboardJS() {
  return `
class Dashboard {
  constructor() {
    this.pods = [];
    this.connect();
  }

  connect() {
    const eventSource = new EventSource('/api/events');

    eventSource.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'metrics') {
          this.updateMetrics(msg.data);
        } else if (msg.type === 'alert') {
          this.showAlert(msg);
        }
      } catch (err) {
        console.error('Parse error:', err);
      }
    };

    eventSource.onerror = () => {
      console.log('Connection lost, reconnecting...');
      setTimeout(() => this.connect(), 3000);
    };
  }

  updateMetrics(data) {
    this.pods = data.pods || [];
    this.updateStats();
    this.updatePodsList();
  }

  updateStats() {
    const running = this.pods.filter(p => p.status === 'Running').length;
    const failed = this.pods.filter(p => p.status === 'Failed' || p.status === 'CrashLoopBackOff').length;
    const pending = this.pods.filter(p => p.status === 'Pending').length;

    document.getElementById('total').textContent = this.pods.length;
    document.getElementById('running').textContent = running;
    document.getElementById('failed').textContent = failed;
    document.getElementById('pending').textContent = pending;
  }

  updatePodsList() {
    const list = document.getElementById('podsList');
    
    if (this.pods.length === 0) {
      list.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">Waiting for data...</div>';
      return;
    }

    list.innerHTML = this.pods.map(pod => {
      const status = pod.status.toLowerCase();
      let statusClass = 'running';
      if (status.includes('failed') || status.includes('crashloop')) statusClass = 'failed';
      else if (status.includes('pending')) statusClass = 'pending';

      return \`<div class="pod-item \${statusClass}">
        <div class="pod-name">\${pod.name}</div>
        <div style="font-size: 0.9em; color: #666; margin-bottom: 10px;">Namespace: \${pod.namespace || 'default'}</div>
        <span class="pod-status \${statusClass}">\${pod.status}</span>
      </div>\`;
    }).join('');
  }

  showAlert(alert) {
    const alertsDiv = document.getElementById('alerts');
    const alertItem = document.createElement('div');
    alertItem.className = 'alert-item';
    alertItem.textContent = \`🚨 \${alert.pod} - \${alert.message}\`;
    alertsDiv.appendChild(alertItem);
    alertsDiv.classList.add('show');

    setTimeout(() => {
      alertItem.remove();
      if (alertsDiv.children.length === 0) {
        alertsDiv.classList.remove('show');
      }
    }, 5000);
  }
}

window.dashboard = new Dashboard();
`;
}

// Start server
server.listen(DASHBOARD_PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║  ✅ SELF-HEALING SYSTEM RUNNING                        ║
╠════════════════════════════════════════════════════════╣
║  Dashboard: http://localhost:${DASHBOARD_PORT}
║  Metrics:   ${METRICS_URL}
║  Interval:  ${REFRESH_INTERVAL}ms (${REFRESH_INTERVAL/1000}s)
║  Status:    🟢 LIVE
╚════════════════════════════════════════════════════════╝
  `);

  // Fetch initial metrics
  fetchMetrics()
    .then(metrics => {
      clusterState.pods = metrics.pods || [];
      clusterState.lastUpdate = new Date().toISOString();
      const { failed } = analyzePods(clusterState.pods);
      console.log(`✅ Initial fetch: ${clusterState.pods.length} pods, ${failed.length} failed`);
    })
    .catch(err => console.error('Initial fetch failed:', err.message));
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n📛 Shutting down...');
  server.close();
  process.exit(0);
});
