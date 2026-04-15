/**
 * Mock Dashboard Server with Manual Controls
 * Interactive testing environment for RCA visualization
 */

const http = require('http');
const { EventEmitter } = require('events');
const MockClusterController = require('./mock-controller');
const observerAgent = require('../agents/observer');
const rcaAgent = require('../agents/rca');

class MockDashboardServer extends EventEmitter {
  constructor(port = 3000) {
    super();
    this.port = port;
    this.mockController = new MockClusterController();
    this.clients = [];
    this.analysisRunning = false;

    // Listen for cluster state changes
    this.mockController.on('stateChanged', (state) => {
      this.broadcast({ type: 'cluster', data: state });
    });

    this.setupRoutes();
  }

  setupRoutes() {
    this.routes = {
      'GET /api/scenarios': this.handleGetScenarios.bind(this),
      'GET /api/scenario/current': this.handleGetCurrentScenario.bind(this),
      'POST /api/scenario/load': this.handleLoadScenario.bind(this),
      'GET /api/pods': this.handleGetPods.bind(this),
      'GET /api/pods/:name': this.handleGetPodDetails.bind(this),
      'POST /api/pods/:name/health': this.handleSetPodHealth.bind(this),
      'POST /api/pods/:name/exhaust': this.handleExhaustResources.bind(this),
      'POST /api/simulate/cascade': this.handleSimulateCascade.bind(this),
      'POST /api/heal-all': this.handleHealAll.bind(this),
      'POST /api/analyze': this.handleAnalyze.bind(this),
      'GET /api/cluster-state': this.handleGetClusterState.bind(this),
    };
  }

  start() {
    const server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    server.listen(this.port, () => {
      console.log(`\n🎮 Mock Dashboard running at http://localhost:${this.port}`);
      console.log(`✨ Interactive controls available at http://localhost:${this.port}\n`);
    });

    return this;
  }

  handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);
    const pathname = url.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      res.end();
      return;
    }

    // Route matching
    const routeKey = `${req.method} ${pathname}`;

    if (pathname === '/') {
      this.serveHTML(res);
    } else if (pathname === '/api/events') {
      this.handleSSE(req, res);
    } else if (routeKey === 'GET /api/scenarios') {
      this.handleGetScenarios(req, res);
    } else if (routeKey === 'GET /api/scenario/current') {
      this.handleGetCurrentScenario(req, res);
    } else if (routeKey.startsWith('POST /api/scenario/load')) {
      this.handleLoadScenario(req, res);
    } else if (routeKey === 'GET /api/pods') {
      this.handleGetPods(req, res);
    } else if (pathname.startsWith('/api/pods/') && pathname.endsWith('/health')) {
      const podName = pathname.split('/')[3];
      this.handleSetPodHealth(req, res, podName);
    } else if (pathname.startsWith('/api/pods/') && pathname.endsWith('/exhaust')) {
      const podName = pathname.split('/')[3];
      this.handleExhaustResources(req, res, podName);
    } else if (routeKey === 'GET /api/cluster-state') {
      this.handleGetClusterState(req, res);
    } else if (routeKey === 'POST /api/simulate/cascade') {
      this.handleSimulateCascade(req, res);
    } else if (routeKey === 'POST /api/heal-all') {
      this.handleHealAll(req, res);
    } else if (routeKey === 'POST /api/analyze') {
      this.handleAnalyze(req, res);
    } else {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  serveHTML(res) {
    const html = this.generateDashboardHTML();
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
  }

  handleSSE(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    this.clients.push(res);

    // Send initial cluster state
    res.write(`data: ${JSON.stringify({ type: 'cluster', data: this.mockController.getClusterState() })}

`);

    req.on('close', () => {
      this.clients = this.clients.filter(c => c !== res);
    });
  }

  broadcast(data) {
    const message = `data: ${JSON.stringify(data)}

`;
    this.clients.forEach(client => {
      client.write(message);
    });
  }

  // API Handlers
  handleGetScenarios(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ scenarios: this.mockController.getScenarios() }));
  }

  handleGetCurrentScenario(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(this.mockController.getCurrentScenario()));
  }

  handleLoadScenario(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { scenario } = JSON.parse(body);
        const success = this.mockController.loadScenario(scenario);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success, scenario: this.mockController.getCurrentScenario() }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
  }

  handleGetPods(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ pods: Array.from(this.mockController.pods.values()) }));
  }

  handleGetPodDetails(req, res, podName) {
    const details = this.mockController.getPodDetails(podName);
    res.setHeader('Content-Type', 'application/json');
    if (details) {
      res.end(JSON.stringify(details));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Pod not found' }));
    }
  }

  handleSetPodHealth(req, res, podName) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { healthy, reason } = JSON.parse(body);
        const success = this.mockController.setPodHealth(podName, healthy, reason);

        if (success) {
          // Auto-trigger analysis if pod becomes unhealthy
          if (!healthy && !this.analysisRunning) {
            this.triggerAnalysis();
          }
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success, pod: this.mockController.pods.get(podName) }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
  }

  handleExhaustResources(req, res, podName) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { resource } = JSON.parse(body);
        const success = this.mockController.exhaustResources(podName, resource);

        if (success && !this.analysisRunning) {
          this.triggerAnalysis();
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success, pod: this.mockController.pods.get(podName) }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
  }

  handleGetClusterState(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(this.mockController.getClusterState()));
  }

  handleSimulateCascade(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { rootPod, delay } = JSON.parse(body);
        const success = this.mockController.simulateCascadingFailure(rootPod, delay);

        if (success && !this.analysisRunning) {
          setTimeout(() => this.triggerAnalysis(), (delay || 1000) * 2);
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success, message: `Simulating cascade from ${rootPod}` }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
  }

  handleHealAll(req, res) {
    this.mockController.healAll();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, message: 'All pods healed' }));
  }

  async handleAnalyze(req, res) {
    await this.triggerAnalysis();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true }));
  }

  async triggerAnalysis() {
    if (this.analysisRunning) return;
    this.analysisRunning = true;

    // Broadcast analysis start
    this.broadcast({ type: 'analysis', status: 'started' });

    const clusterState = this.mockController.getClusterState();

    // Run observer analysis
    const analysis = observerAgent.analyzeClusterState(clusterState);

    this.broadcast({
      type: 'analysis',
      status: 'issues-detected',
      data: analysis
    });

    // Run RCA if issues found
    if (analysis.issues.length > 0) {
      const rca = rcaAgent.performRCA(clusterState, analysis.issues);

      this.broadcast({
        type: 'rca',
        data: rca
      });
    }

    this.analysisRunning = false;
  }

  generateDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Self-Healing System - Mock Controller</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      min-height: 100vh;
    }

    .header {
      background: linear-gradient(135deg, #1a1f2e 0%, #0d1117 100%);
      border-bottom: 1px solid #30363d;
      padding: 20px 30px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 15px;
    }

    .header h1 {
      font-size: 24px;
      background: linear-gradient(90deg, #58a6ff, #a371f7);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .scenario-badge {
      background: rgba(88, 166, 255, 0.15);
      color: #58a6ff;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid rgba(88, 166, 255, 0.3);
    }

    .container {
      padding: 20px 30px;
      max-width: 1800px;
      margin: 0 auto;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }

    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 20px;
      transition: transform 0.2s, box-shadow 0.2s;
    }

    .card:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 15px;
      font-size: 16px;
      font-weight: 600;
      color: #e6edf3;
    }

    .card-header .icon {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      font-size: 14px;
      background: rgba(88, 166, 255, 0.15);
      color: #58a6ff;
    }

    /* Pod Controls */
    .pod-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 12px;
    }

    .pod-card {
      background: #0d1117;
      border: 2px solid #30363d;
      border-radius: 10px;
      padding: 15px;
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
    }

    .pod-card.healthy {
      border-color: #238636;
    }

    .pod-card.unhealthy {
      border-color: #ef4444;
      animation: pulse-red 2s infinite;
    }

    .pod-card.cascade-root {
      border-color: #d29922;
      box-shadow: 0 0 15px rgba(210, 153, 34, 0.3);
    }

    @keyframes pulse-red {
      0%, 100% { box-shadow: 0 0 5px rgba(239, 68, 68, 0.3); }
      50% { box-shadow: 0 0 20px rgba(239, 68, 68, 0.6); }
    }

    .pod-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .pod-name {
      font-weight: 600;
      font-size: 14px;
      color: #e6edf3;
    }

    .pod-status {
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .pod-status.running {
      background: rgba(35, 134, 54, 0.2);
      color: #3fb950;
    }

    .pod-status.failed {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }

    .pod-status.pending {
      background: rgba(210, 153, 34, 0.2);
      color: #d29922;
    }

    .pod-metrics {
      display: flex;
      gap: 10px;
      margin-bottom: 12px;
    }

    .metric {
      flex: 1;
      background: #161b22;
      padding: 8px;
      border-radius: 6px;
      text-align: center;
    }

    .metric-value {
      font-size: 18px;
      font-weight: 700;
      color: #e6edf3;
    }

    .metric-label {
      font-size: 10px;
      color: #8b949e;
      text-transform: uppercase;
    }

    .pod-controls {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .btn {
      border: none;
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .btn:hover {
      transform: translateY(-1px);
    }

    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .btn-danger:hover {
      background: rgba(239, 68, 68, 0.25);
    }

    .btn-success {
      background: rgba(35, 197, 94, 0.15);
      color: #22c55e;
      border: 1px solid rgba(35, 197, 94, 0.3);
    }

    .btn-success:hover {
      background: rgba(35, 197, 94, 0.25);
    }

    .btn-warning {
      background: rgba(210, 153, 34, 0.15);
      color: #d29922;
      border: 1px solid rgba(210, 153, 34, 0.3);
    }

    .btn-primary {
      background: rgba(88, 166, 255, 0.15);
      color: #58a6ff;
      border: 1px solid rgba(88, 166, 255, 0.3);
    }

    .btn-primary:hover {
      background: rgba(88, 166, 255, 0.25);
    }

    /* Scenario Selector */
    .scenario-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 10px;
    }

    .scenario-card {
      background: #0d1117;
      border: 2px solid #30363d;
      border-radius: 8px;
      padding: 15px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .scenario-card:hover {
      border-color: #58a6ff;
    }

    .scenario-card.active {
      border-color: #238636;
      background: rgba(35, 134, 54, 0.1);
    }

    .scenario-name {
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 4px;
    }

    .scenario-desc {
      font-size: 12px;
      color: #8b949e;
    }

    /* RCA Visualization */
    .rca-section {
      display: none;
    }

    .rca-section.visible {
      display: block;
    }

    .flowchart-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0;
      padding: 20px;
      position: relative;
    }

    .flow-node {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 24px;
      border-radius: 10px;
      border: 2px solid;
      min-width: 320px;
      max-width: 450px;
      position: relative;
      transition: all 0.3s ease;
    }

    .flow-node.root {
      background: linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(239, 68, 68, 0.1));
      border-color: #ef4444;
      box-shadow: 0 0 20px rgba(239, 68, 68, 0.4);
      animation: glow-red 2s ease-in-out infinite;
    }

    @keyframes glow-red {
      0%, 100% { box-shadow: 0 0 20px rgba(239, 68, 68, 0.4); }
      50% { box-shadow: 0 0 40px rgba(239, 68, 68, 0.7); }
    }

    .flow-node.cascade {
      background: linear-gradient(135deg, rgba(210, 153, 34, 0.15), rgba(210, 153, 34, 0.05));
      border-color: #d29922;
    }

    .flow-node.impact {
      background: linear-gradient(135deg, rgba(88, 166, 255, 0.15), rgba(88, 166, 255, 0.05));
      border-color: #58a6ff;
    }

    .flow-node.healthy {
      background: linear-gradient(135deg, rgba(35, 197, 94, 0.15), rgba(35, 197, 94, 0.05));
      border-color: #22c55e;
      opacity: 0.7;
    }

    .flow-node-icon {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      font-size: 16px;
      flex-shrink: 0;
    }

    .flow-node-icon.error {
      background: rgba(239, 68, 68, 0.3);
      color: #ef4444;
      animation: bounce 1s infinite;
    }

    @keyframes bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-3px); }
    }

    .flow-node-icon.warning {
      background: rgba(210, 153, 34, 0.3);
      color: #d29922;
    }

    .flow-node-icon.healthy {
      background: rgba(35, 197, 94, 0.3);
      color: #22c55e;
    }

    .flow-node-info {
      flex: 1;
    }

    .flow-node-name {
      font-weight: 600;
      font-size: 14px;
      color: #e6edf3;
      margin-bottom: 3px;
    }

    .flow-node-status {
      font-size: 12px;
      color: #8b949e;
    }

    .flow-node-badge {
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .flow-node-badge.root {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }

    .flow-connector {
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 50px;
      position: relative;
      width: 100%;
    }

    .flow-connector-line {
      width: 3px;
      flex: 1;
      background: linear-gradient(180deg, #ef4444 0%, #d29922 50%, #58a6ff 100%);
      position: relative;
      overflow: hidden;
    }

    .flow-connector-line::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 20px;
      background: linear-gradient(180deg, transparent, rgba(255,255,255,0.3), transparent);
      animation: flow 1.5s linear infinite;
    }

    @keyframes flow {
      0% { transform: translateY(-100%); }
      100% { transform: translateY(300%); }
    }

    .flow-connector-arrow {
      color: #d29922;
      font-size: 14px;
      margin-top: -8px;
      animation: pulse-arrow 1s ease-in-out infinite;
    }

    @keyframes pulse-arrow {
      0%, 100% { opacity: 0.5; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.2); }
    }

    .flow-label {
      position: absolute;
      right: 20%;
      font-size: 11px;
      color: #8b949e;
      background: #161b22;
      padding: 2px 10px;
      border-radius: 4px;
      border: 1px solid #30363d;
    }

    /* Timeline */
    .timeline {
      max-height: 350px;
      overflow-y: auto;
      font-family: 'Monaco', 'Consolas', monospace;
      font-size: 13px;
    }

    .timeline-item {
      display: flex;
      gap: 12px;
      padding: 10px 0;
      border-bottom: 1px solid #21262d;
      animation: slideIn 0.3s ease;
    }

    @keyframes slideIn {
      from { opacity: 0; transform: translateX(-20px); }
      to { opacity: 1; transform: translateX(0); }
    }

    .timeline-time {
      color: #8b949e;
      flex-shrink: 0;
      width: 80px;
    }

    .timeline-type {
      flex-shrink: 0;
      width: 90px;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 10px;
      text-align: center;
      font-weight: 600;
    }

    .timeline-type.analysis { background: rgba(88, 166, 255, 0.15); color: #58a6ff; }
    .timeline-type.issue { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
    .timeline-type.rca { background: rgba(210, 153, 34, 0.15); color: #d29922; }
    .timeline-type.fix { background: rgba(139, 148, 158, 0.15); color: #8b949e; }
    .timeline-type.success { background: rgba(35, 197, 94, 0.15); color: #22c55e; }

    .timeline-message {
      color: #c9d1d9;
    }

    /* Stats */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 15px;
    }

    .stat-card {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 15px;
      text-align: center;
    }

    .stat-value {
      font-size: 32px;
      font-weight: 700;
      margin-bottom: 4px;
    }

    .stat-value.healthy { color: #22c55e; }
    .stat-value.unhealthy { color: #ef4444; }
    .stat-value.warning { color: #d29922; }

    .stat-label {
      font-size: 12px;
      color: #8b949e;
    }

    /* Global Actions */
    .actions-bar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      padding: 15px;
      background: #0d1117;
      border-radius: 10px;
      margin-bottom: 20px;
    }

    .btn-large {
      padding: 12px 24px;
      font-size: 14px;
    }

    /* Dependency Graph Visualization */
    .dep-graph {
      display: flex;
      flex-direction: column;
      gap: 20px;
      padding: 20px;
    }

    .dep-level {
      display: flex;
      justify-content: center;
      gap: 30px;
      flex-wrap: wrap;
    }

    .dep-node {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }

    .dep-node-circle {
      width: 60px;
      height: 60px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      border: 3px solid;
      transition: all 0.3s;
    }

    .dep-node-circle.healthy {
      border-color: #22c55e;
      background: rgba(35, 197, 94, 0.1);
    }

    .dep-node-circle.unhealthy {
      border-color: #ef4444;
      background: rgba(239, 68, 68, 0.1);
      animation: shake 0.5s infinite;
    }

    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-3px); }
      75% { transform: translateX(3px); }
    }

    .dep-node-label {
      font-size: 12px;
      color: #8b949e;
    }

    .full-width {
      grid-column: 1 / -1;
    }

    /* Analysis overlay */
    .analyzing-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(13, 17, 23, 0.9);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      flex-direction: column;
      gap: 20px;
    }

    .analyzing-overlay.active {
      display: flex;
    }

    .spinner {
      width: 60px;
      height: 60px;
      border: 4px solid #30363d;
      border-top-color: #58a6ff;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .analyzing-text {
      font-size: 18px;
      color: #e6edf3;
    }

    /* Confidence bar */
    .confidence-section {
      margin-top: 15px;
      padding: 15px;
      background: #0d1117;
      border-radius: 8px;
    }

    .confidence-label {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: #8b949e;
      margin-bottom: 8px;
    }

    .confidence-bar {
      height: 8px;
      background: #21262d;
      border-radius: 4px;
      overflow: hidden;
    }

    .confidence-fill {
      height: 100%;
      background: linear-gradient(90deg, #ef4444, #d29922, #22c55e);
      transition: width 0.5s ease;
    }

    /* Scrollbar */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    ::-webkit-scrollbar-track {
      background: #0d1117;
    }

    ::-webkit-scrollbar-thumb {
      background: #30363d;
      border-radius: 4px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: #484f58;
    }
  </style>
</head>
<body>
  <div class="analyzing-overlay" id="analyzingOverlay">
    <div class="spinner"></div>
    <div class="analyzing-text">🔍 Analyzing cluster state...</div>
  </div>

  <div class="header">
    <div>
      <h1>🎮 Self-Healing System - Interactive Mock Controller</h1>
      <div style="margin-top: 8px; color: #8b949e; font-size: 14px;">
        Manually control containers and watch RCA trace failure chains in real-time
      </div>
    </div>
    <div class="scenario-badge" id="currentScenario">Loading...</div>
  </div>

  <div class="container">
    <!-- Actions Bar -->
    <div class="actions-bar">
      <button class="btn btn-success btn-large" onclick="healAll()">🔄 Heal All Pods</button>
      <button class="btn btn-primary btn-large" onclick="triggerAnalysis()">🔍 Run Analysis</button>
      <button class="btn btn-warning" onclick="simulateRandomFailure()">🎲 Random Failure</button>
      <button class="btn btn-warning" onclick="simulateCascadeFromLeaf()">⬇️ Simulate Cascade</button>
    </div>

    <div class="grid">
      <!-- Pod Controls -->
      <div class="card full-width">
        <div class="card-header">
          <div class="icon">🐳</div>
          Container Controls
          <span style="margin-left: auto; color: #8b949e; font-size: 13px; font-weight: normal;">
            Click buttons to toggle pod health and trigger RCA
          </span>
        </div>
        <div class="pod-grid" id="podGrid">
          <!-- Pods rendered here -->
        </div>
      </div>

      <!-- Stats -->
      <div class="card">
        <div class="card-header">
          <div class="icon">📊</div>
          Cluster Health
        </div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-value healthy" id="statHealthy">0</div>
            <div class="stat-label">Healthy</div>
          </div>
          <div class="stat-card">
            <div class="stat-value unhealthy" id="statUnhealthy">0</div>
            <div class="stat-label">Unhealthy</div>
          </div>
          <div class="stat-card">
            <div class="stat-value warning" id="statIssues">0</div>
            <div class="stat-label">Active Issues</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" id="statTotal">0</div>
            <div class="stat-label">Total Pods</div>
          </div>
        </div>
      </div>

      <!-- Scenario Selector -->
      <div class="card">
        <div class="card-header">
          <div class="icon">🎭</div>
          Scenarios
        </div>
        <div class="scenario-grid" id="scenarioGrid">
          <!-- Scenarios rendered here -->
        </div>
      </div>

      <!-- RCA Visualization -->
      <div class="card full-width rca-section" id="rcaSection">
        <div class="card-header">
          <div class="icon">🌳</div>
          Root Cause Analysis
          <div style="margin-left: auto; display: flex; gap: 10px; align-items: center;">
            <span id="rcaConfidence" style="color: #8b949e; font-size: 13px;">Confidence: 0%</span>
          </div>
        </div>
        <div class="flowchart-container" id="flowchartContainer">
          <!-- Flowchart rendered here -->
        </div>
        <div class="confidence-section">
          <div class="confidence-label">
            <span>Analysis Confidence</span>
            <span id="confidenceValue">0%</span>
          </div>
          <div class="confidence-bar">
            <div class="confidence-fill" id="confidenceFill" style="width: 0%"></div>
          </div>
        </div>
      </div>

      <!-- Timeline -->
      <div class="card full-width">
        <div class="card-header">
          <div class="icon">⏱️</div>
          Event Timeline
        </div>
        <div class="timeline" id="timeline">
          <p style="color: #8b949e; text-align: center; padding: 40px 0;">Events will appear here...</p>
        </div>
      </div>
    </div>
  </div>

  <script>
    let eventSource;
    let pods = [];
    let currentScenario = '';
    let rcaData = null;
    let issues = [];

    function connect() {
      eventSource = new EventSource('/api/events');

      eventSource.onmessage = (e) => {
        const data = JSON.parse(e.data);
        handleUpdate(data);
      };

      eventSource.onerror = () => {
        console.log('Connection lost, retrying...');
        eventSource.close();
        setTimeout(connect, 1000);
      };
    }

    function handleUpdate(data) {
      if (data.type === 'cluster') {
        updatePods(data.data.pods);
      } else if (data.type === 'analysis') {
        handleAnalysisUpdate(data);
      } else if (data.type === 'rca') {
        updateRCADisplay(data.data);
      }
    }

    function updatePods(newPods) {
      pods = newPods;
      renderPods();
      updateStats();
    }

    function renderPods() {
      const grid = document.getElementById('podGrid');
      grid.innerHTML = pods.map(pod => {
        const isHealthy = pod.phase === 'Running' && pod.ready;
        const hasIssues = pod.memory > 90 || pod.cpu > 90 || pod.restarts > 5;

        // Determine pod type emoji
        const typeEmoji = getPodTypeEmoji(pod.podType || pod.labels?.tier || 'default');

        return \`
          <div class="pod-card \${isHealthy ? 'healthy' : 'unhealthy'}" id="pod-\${pod.name}">
            <div class="pod-header">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 18px;">\${typeEmoji}</span>
                <div class="pod-name">\${pod.name}</div>
              </div>
              <div class="pod-status \${isHealthy ? 'running' : pod.phase?.toLowerCase()}">
                \${isHealthy ? 'Running' : pod.phase}
              </div>
            </div>
            <div class="pod-metrics">
              <div class="metric">
                <div class="metric-value" style="color: \${pod.cpu > 80 ? '#ef4444' : '#e6edf3'}">\${Math.round(pod.cpu)}%</div>
                <div class="metric-label">CPU</div>
              </div>
              <div class="metric">
                <div class="metric-value" style="color: \${pod.memory > 80 ? '#ef4444' : '#e6edf3'}">\${Math.round(pod.memory)}%</div>
                <div class="metric-label">Memory</div>
              </div>
              <div class="metric">
                <div class="metric-value" style="color: \${pod.restarts > 3 ? '#ef4444' : '#e6edf3'}">\${pod.restarts}</div>
                <div class="metric-label">Restarts</div>
              </div>
            </div>
            <div class="pod-controls">
              <button class="btn btn-danger" onclick="breakPod('\${pod.name}')">💥 Break</button>
              <button class="btn btn-success" onclick="healPod('\${pod.name}')">✅ Heal</button>
              <button class="btn btn-warning" onclick="exhaustPod('\${pod.name}')">🔥 Exhaust</button>
              <button class="btn btn-primary" onclick="cascadeFrom('\${pod.name}')">⬇️ Cascade</button>
            </div>
          </div>
        \`;
      }).join('');
    }

    function getPodTypeEmoji(type) {
      const emojiMap = {
        'frontend': '🌐',
        'web': '🌐',
        'api': '🔌',
        'gateway': '🚪',
        'service': '⚙️',
        'worker': '👷',
        'database': '🗄️',
        'cache': '⚡',
        'redis': '⚡',
        'proxy': '🛡️',
        'lb': '⚖️',
        'app': '📱',
        'scheduler': '📅',
        'default': '📦'
      };
      return emojiMap[type?.toLowerCase()] || emojiMap['default'];
    }

    function updateStats() {
      const healthy = pods.filter(p => p.phase === 'Running' && p.ready).length;
      const unhealthy = pods.length - healthy;

      document.getElementById('statHealthy').textContent = healthy;
      document.getElementById('statUnhealthy').textContent = unhealthy;
      document.getElementById('statTotal').textContent = pods.length;
      document.getElementById('statIssues').textContent = issues.length;
    }

    // API Actions
    async function breakPod(podName) {
      await fetch(\`/api/pods/\${podName}/health\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ healthy: false, reason: 'Manual failure' })
      });
      addTimelineItem('issue', \`Manually broke pod: \${podName}\`);
    }

    async function healPod(podName) {
      await fetch(\`/api/pods/\${podName}/health\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ healthy: true })
      });
      addTimelineItem('success', \`Healed pod: \${podName}\`);
    }

    async function exhaustPod(podName, resource = 'memory') {
      await fetch(\`/api/pods/\${podName}/exhaust\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource })
      });
      addTimelineItem('issue', \`Exhausted \${resource} on: \${podName}\`);
    }

    async function cascadeFrom(podName) {
      await fetch('/api/simulate/cascade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootPod: podName, delay: 800 })
      });
      addTimelineItem('issue', \`Started cascade from: \${podName}\`);
    }

    async function healAll() {
      await fetch('/api/heal-all', { method: 'POST' });
      issues = [];
      rcaData = null;
      document.getElementById('rcaSection').classList.remove('visible');
      addTimelineItem('success', 'Healed all pods');
    }

    async function triggerAnalysis() {
      document.getElementById('analyzingOverlay').classList.add('active');
      await fetch('/api/analyze', { method: 'POST' });
      setTimeout(() => {
        document.getElementById('analyzingOverlay').classList.remove('active');
      }, 1000);
      addTimelineItem('analysis', 'Triggered manual analysis');
    }

    async function loadScenario(scenarioId) {
      await fetch('/api/scenario/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: scenarioId })
      });
      issues = [];
      rcaData = null;
      document.getElementById('rcaSection').classList.remove('visible');
      fetchScenarios();
      addTimelineItem('success', \`Loaded scenario: \${scenarioId}\`);
    }

    async function simulateRandomFailure() {
      if (pods.length === 0) return;
      const randomPod = pods[Math.floor(Math.random() * pods.length)];
      await breakPod(randomPod.name);
    }

    async function simulateCascadeFromLeaf() {
      // Find the pod with most dependencies pointing to it (likely a root)
      const rootPods = pods.filter(p => {
        const deps = p.dependencies || [];
        return deps.length === 0;
      });

      if (rootPods.length > 0) {
        const randomRoot = rootPods[Math.floor(Math.random() * rootPods.length)];
        await cascadeFrom(randomRoot.name);
      }
    }

    // RCA Display
    function updateRCADisplay(rca) {
      if (!rca || !rca.rootCause) return;

      rcaData = rca;
      const section = document.getElementById('rcaSection');
      section.classList.add('visible');

      document.getElementById('rcaConfidence').textContent = \`Confidence: \${rca.confidence}%\`;
      document.getElementById('confidenceValue').textContent = rca.confidence + '%';
      document.getElementById('confidenceFill').style.width = rca.confidence + '%';

      renderFlowchart(rca);
    }

    function renderFlowchart(rca) {
      const container = document.getElementById('flowchartContainer');
      const chain = rca.chainDetails || [];
      const rootCause = rca.rootCause;

      if (chain.length === 0) {
        container.innerHTML = '<p style="color: #8b949e; text-align: center;">No chain data available</p>';
        return;
      }

      // Sort by depth
      const sortedChain = chain.slice().sort((a, b) => a.depth - b.depth);

      let html = '';
      sortedChain.forEach((step, index) => {
        const isRoot = step.name === rootCause;
        const isLast = index === sortedChain.length - 1;
        const nodeClass = isRoot ? 'root' : (!step.health?.healthy ? 'cascade' : (step.health?.healthy ? 'healthy' : 'impact'));
        const iconClass = isRoot ? 'error' : (!step.health?.healthy ? 'warning' : 'healthy');
        const icon = isRoot ? '💥' : (!step.health?.healthy ? '⚡' : '✓');
        const statusText = isRoot ? 'ROOT CAUSE' : (step.health?.healthy ? 'HEALTHY' : 'AFFECTED');

        html += \`
          <div class="flow-node \${nodeClass}">
            <div class="flow-node-icon \${iconClass}">\${icon}</div>
            <div class="flow-node-info">
              <div class="flow-node-name">\${step.name}</div>
              <div class="flow-node-status">\${statusText}: \${step.health?.reason || 'Unknown'}</div>
            </div>
            \${isRoot ? '<div class="flow-node-badge root">ROOT</div>' : ''}
          </div>
        \`;

        if (!isLast) {
          html += \`
            <div class="flow-connector">
              <div class="flow-connector-line"></div>
              <div class="flow-connector-arrow">▼</div>
              <div class="flow-label">cascades to</div>
            </div>
          \`;
        }
      });

      container.innerHTML = html;
    }

    function handleAnalysisUpdate(data) {
      if (data.status === 'started') {
        document.getElementById('analyzingOverlay').classList.add('active');
      } else if (data.status === 'issues-detected' && data.data) {
        issues = data.data.issues || [];
        updateStats();
        document.getElementById('analyzingOverlay').classList.remove('active');

        // Update timeline
        if (issues.length > 0) {
          issues.forEach(issue => {
            addTimelineItem('issue', issue.problem);
          });
        }
      }
    }

    // Timeline
    function addTimelineItem(type, message) {
      const timeline = document.getElementById('timeline');
      const time = new Date().toLocaleTimeString();

      const item = document.createElement('div');
      item.className = 'timeline-item';
      item.innerHTML = \`
        <div class="timeline-time">\${time}</div>
        <div class="timeline-type \${type}">\${type.toUpperCase()}</div>
        <div class="timeline-message">\${message}</div>
      \`;

      if (timeline.children.length === 1 && timeline.children[0].tagName === 'P') {
        timeline.innerHTML = '';
      }

      timeline.insertBefore(item, timeline.firstChild);
    }

    // Load scenarios
    async function fetchScenarios() {
      const res = await fetch('/api/scenarios');
      const data = await res.json();

      const grid = document.getElementById('scenarioGrid');
      grid.innerHTML = data.scenarios.map(s => \`
        <div class="scenario-card \${s.id === currentScenario ? 'active' : ''}" onclick="loadScenario('\${s.id}')">
          <div class="scenario-name">\${s.name}</div>
          <div class="scenario-desc">\${s.description}</div>
          <div style="margin-top: 8px; font-size: 11px; color: #58a6ff;">\${s.podCount} pods</div>
        </div>
      \`).join('');
    }

    async function fetchCurrentScenario() {
      const res = await fetch('/api/scenario/current');
      const data = await res.json();
      currentScenario = data.name;
      document.getElementById('currentScenario').textContent = data.name + ' - ' + data.description;
    }

    // Initial load
    async function init() {
      const res = await fetch('/api/cluster-state');
      const data = await res.json();
      updatePods(data.pods);

      await fetchCurrentScenario();
      await fetchScenarios();
      connect();
    }

    init();
  </script>
</body>
</html>`;
  }
}

module.exports = MockDashboardServer;
