/**
 * Dashboard Server
 * Modern Web UI for the Self-Healing System
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const SelfHealingSystem = require('../main');
const DependencyGraph = require('../adapters/dependencyGraph');

class DashboardServer extends EventEmitter {
  constructor(port = 3000) {
    super();
    this.port = port;
    this.events = [];
    this.dependencyGraph = new DependencyGraph();
    this.alerts = [];
    this.failureHistory = {};
    this.currentState = {
      healthy: true,
      issues: [],
      agents: {
        observer: { status: 'idle', lastRun: null },
        detector: { status: 'idle', lastRun: null },
        rca: { status: 'idle', lastRun: null },
        executor: { status: 'idle', lastRun: null }
      },
      memory: { totalLearnings: 0, successRate: 100 },
      timeline: [],
      rca: null,
      metricsUrl: process.env.METRICS_URL || '',
      raw: null,  // Raw metrics data including pods
      dependencyGraph: null,  // Dependency graph visualization
      failureAnalysis: null,  // Failure impact analysis
      alerts: []  // Active alerts
    };
    this.clients = [];
    this.dashboardDir = path.join(__dirname);
    this.isRunning = false;

    // Bridge to SelfHealingSystem
    SelfHealingSystem.onAgentStatus((agent, status, data) => {
      this.setAgentStatus(agent, status, data);
    });

    // Listen for metrics updates
    SelfHealingSystem.onMetricsUpdate((data) => {
      this.setMetricsData(data);
    });
  }

  start() {
    // Auto-configure ngrok URL on startup
    const ngrokUrl = 'https://refocus-cement-spud.ngrok-free.dev/pods';
    this.currentState.metricsUrl = ngrokUrl;
    SelfHealingSystem.setMetricsUrl(ngrokUrl);
    console.log(`🔄 Auto-configured metrics URL: ${ngrokUrl}`);

    const server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    server.listen(this.port, '0.0.0.0', () => {
      console.log(`✅ Dashboard server running at http://0.0.0.0:${this.port}`);
      console.log(`   Dashboard: http://localhost:${this.port}`);
      console.log(`   Metrics URL: ${ngrokUrl}`);
    });

    return this;
  }

  handleRequest(req, res) {
    const url = req.url;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Route handling
    if (url === '/' || url === '/index.html') {
      this.serveHTML(res);
    } else if (url === '/dashboard/app.js') {
      this.serveJS(res);
    } else if (url === '/api/state') {
      this.serveJSON(res, this.currentState);
    } else if (url === '/api/events') {
      this.handleSSE(req, res);
    } else if (url === '/api/trigger' && req.method === 'POST') {
      this.handleTrigger(res);
    } else if (url === '/api/config' && req.method === 'POST') {
      this.handleConfigUpdate(req, res);
    } else {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  serveHTML(res) {
    try {
      const htmlPath = path.join(this.dashboardDir, 'index.html');
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.setHeader('Content-Type', 'text/html');
        res.end(html);
      } else {
        res.statusCode = 500;
        res.end('Dashboard HTML not found');
      }
    } catch (error) {
      console.error('Error serving HTML:', error);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  }

  serveJS(res) {
    try {
      const jsPath = path.join(this.dashboardDir, 'app.js');
      if (fs.existsSync(jsPath)) {
        const js = fs.readFileSync(jsPath, 'utf8');
        res.setHeader('Content-Type', 'application/javascript');
        res.end(js);
      } else {
        res.statusCode = 404;
        res.end('Not found');
      }
    } catch (error) {
      console.error('Error serving JS:', error);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  }

  serveJSON(res, data) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  }

  handleSSE(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    this.clients.push(res);

    // Send initial state
    res.write(`data: ${JSON.stringify({ type: 'state', data: this.currentState })}\n\n`);

    req.on('close', () => {
      this.clients = this.clients.filter(c => c !== res);
    });

    // Keep-alive ping
    const keepAlive = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(keepAlive);
        return;
      }
      res.write(':ping\n\n');
    }, 30000);
  }

  async handleTrigger(res) {
    if (this.isRunning) {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 409;
      res.end(JSON.stringify({ success: false, message: 'Already running' }));
      return;
    }

    this.isRunning = true;
    this.setRunning(true);
    this.addTimelineEvent({ type: 'analysis', description: 'Self-healing cycle started' });

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, message: 'Healing triggered' }));

    // Run self-healing in background
    try {
      const result = await SelfHealingSystem.runSelfHealingSystem({
        onAnalysis: (analysis) => {
          this.updateState({
            healthy: analysis.healthy,
            issues: analysis.issues || [],
            raw: this.currentState.raw
          });
        },
        onDetection: (detection) => {
          if (detection.confirmedIssues?.length > 0) {
            detection.confirmedIssues.forEach(issue => {
              this.addTimelineEvent({
                type: 'issue',
                description: `${issue.target}: ${issue.problem}`
              });
            });
          }
        },
        onRCA: (rcaData) => {
          this.setRCAResult(rcaData);
          if (rcaData.rootCause) {
            this.addTimelineEvent({
              type: 'rca',
              description: `Root cause identified: ${rcaData.rootCause} (${rcaData.confidence}% confidence)`
            });
          }
        }
      });

      // Update final state
      this.updateState({
        healthy: result.success,
        memory: SelfHealingSystem.getMemoryStats()
      });

      this.addTimelineEvent({
        type: result.success ? 'success' : 'issue',
        description: result.success ? 'Self-healing completed successfully' : `Issues remain after ${result.attempts} attempts`
      });

    } catch (error) {
      console.error('Self-healing error:', error);
      this.addTimelineEvent({
        type: 'issue',
        description: `Error: ${error.message}`
      });
    } finally {
      this.isRunning = false;
      this.setRunning(false);
    }
  }

  handleConfigUpdate(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const config = JSON.parse(body);
        if (config.metricsUrl) {
          this.currentState.metricsUrl = config.metricsUrl;
          SelfHealingSystem.setMetricsUrl(config.metricsUrl);
          console.log(`📝 Metrics URL updated: ${config.metricsUrl}`);
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  broadcast(data) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    this.clients = this.clients.filter(client => {
      if (client.writableEnded) return false;
      try {
        client.write(message);
        return true;
      } catch (err) {
        return false;
      }
    });
  }

  updateState(update) {
    Object.assign(this.currentState, update);
    this.broadcast({ type: 'state', data: this.currentState });
  }

  addTimelineEvent(event) {
    this.currentState.timeline.unshift({
      time: new Date().toLocaleTimeString(),
      timestamp: new Date().toISOString(),
      ...event
    });
    if (this.currentState.timeline.length > 100) {
      this.currentState.timeline.pop();
    }
    this.broadcast({ type: 'timeline', data: event });
  }

  setAgentStatus(agent, status, data = {}) {
    this.currentState.agents[agent] = {
      status,
      lastRun: new Date().toISOString(),
      ...data
    };
    this.broadcast({ type: 'agent', agent, status: this.currentState.agents[agent] });
  }

  setMetricsData(metricsData) {
    // Store raw metrics data (includes pods) - ensure pods array exists
    this.currentState.raw = metricsData;
    this.currentState.pods = metricsData.pods || [];
    this.currentState.lastMetricsUpdate = new Date().toISOString();

    // Log received metrics
    const podCount = metricsData.pods?.length || 0;
    console.log(`📊 Dashboard received ${podCount} pods from metrics endpoint`);

    // Build dynamic dependency graph from actual metrics
    this.buildDynamicDependencyGraph(metricsData.pods || []);

    // Analyze failed pods and generate alerts
    this.analyzeFailedPods(metricsData);

    // Update dependency graph
    this.currentState.dependencyGraph = this.dependencyGraph.getGraphData();

    // Broadcast state update which includes pods
    this.broadcast({ type: 'state', data: this.currentState });
  }

  buildDynamicDependencyGraph(pods) {
    if (!pods || pods.length === 0) return;

    // Extract dependencies from pods and add to graph
    pods.forEach(pod => {
      const podName = pod.name || 'unknown';

      // Add node if not exists
      if (!this.dependencyGraph.dependencies[podName]) {
        this.dependencyGraph.dependencies[podName] = {
          dependsOn: [],
          criticality: this.inferCriticality(pod),
          services: [pod.namespace || 'default']
        };
      }

      // Add dependencies from pod data
      if (pod.dependencies) {
        pod.dependencies.forEach(dep => {
          const depTarget = dep.resolvedTo || dep.target || dep.name;
          if (depTarget && !this.dependencyGraph.dependencies[podName].dependsOn.includes(depTarget)) {
            this.dependencyGraph.dependencies[podName].dependsOn.push(depTarget);
          }
        });
      }

      // Add reverse dependencies
      if (pod.dependencies) {
        pod.dependencies.forEach(dep => {
          const depTarget = dep.resolvedTo || dep.target || dep.name;
          if (!this.dependencyGraph.reverseDepMap[depTarget]) {
            this.dependencyGraph.reverseDepMap[depTarget] = [];
          }
          if (!this.dependencyGraph.reverseDepMap[depTarget].includes(podName)) {
            this.dependencyGraph.reverseDepMap[depTarget].push(podName);
          }
        });
      }
    });

    // Infer database dependencies from naming
    this.inferDatabaseDependencies(pods);
  }

  inferCriticality(pod) {
    const name = (pod.name || '').toLowerCase();
    if (name.includes('api') || name.includes('gateway') || name.includes('auth')) return 'critical';
    if (name.includes('db') || name.includes('postgres') || name.includes('redis')) return 'critical';
    if (name.includes('payment') || name.includes('order')) return 'critical';
    if (name.includes('web') || name.includes('frontend')) return 'high';
    return 'medium';
  }

  inferDatabaseDependencies(pods) {
    // Find database pods
    const dbPods = pods.filter(p => {
      const name = (p.name || '').toLowerCase();
      return name.includes('db') || name.includes('postgres') || name.includes('redis') || name.includes('mongo');
    });

    // Find app pods that likely depend on databases
    const appPods = pods.filter(p => {
      const name = (p.name || '').toLowerCase();
      return name.includes('api') || name.includes('app') || name.includes('web') || name.includes('service');
    });

    // Infer dependencies
    appPods.forEach(appPod => {
      dbPods.forEach(dbPod => {
        const appDeps = this.dependencyGraph.dependencies[appPod.name]?.dependsOn || [];
        // Check if dependency already exists
        const hasDbDep = appDeps.some(dep =>
          (dbPod.name || '').toLowerCase().includes(dep.toLowerCase()) ||
          dep.toLowerCase().includes((dbPod.name || '').toLowerCase())
        );

        if (!hasDbDep) {
          // Infer dependency based on namespace or naming
          if (appPod.namespace === dbPod.namespace || appPod.namespace === 'default') {
            if (!this.dependencyGraph.dependencies[appPod.name]) {
              this.dependencyGraph.dependencies[appPod.name] = {
                dependsOn: [],
                criticality: 'high',
                services: [appPod.namespace || 'default']
              };
            }
            this.dependencyGraph.dependencies[appPod.name].dependsOn.push(dbPod.name);
          }
        }
      });
    });
  }

  analyzeFailedPods(metricsData) {
    if (!metricsData.pods) return;

    // Find failed pods
    const failedPods = metricsData.pods
      .filter(pod => pod.status === 'Failed' || pod.status === 'CrashLoopBackOff')
      .map(pod => pod.name);

    if (failedPods.length === 0) {
      // Clear alerts if no failures
      this.alerts = this.alerts.filter(a => a.type !== 'failure');
      this.currentState.alerts = this.alerts;
      return;
    }

    // Analyze failure impact
    const failureAnalysis = this.dependencyGraph.analyzeFailureImpact(failedPods);
    this.currentState.failureAnalysis = failureAnalysis;

    // Create alerts
    const previousAlerts = this.alerts.filter(a => a.type === 'failure').map(a => a.pod);
    const newFailures = failedPods.filter(p => !previousAlerts.includes(p));

    newFailures.forEach(pod => {
      const podInfo = this.dependencyGraph.formatDependencyInfo(pod);
      const severity = podInfo.criticality === 'critical' ? 'critical' : 'warning';

      // Create alert
      const alert = {
        id: `${pod}-${Date.now()}`,
        type: 'failure',
        severity,
        pod,
        timestamp: new Date().toISOString(),
        message: `Pod ${pod} has failed`,
        criticality: podInfo.criticality,
        dependents: podInfo.dependentServices,
        recommendations: failureAnalysis.recommendations,
        impactScore: failureAnalysis.impactScore
      };

      this.alerts.push(alert);
      this.failureHistory[pod] = this.failureHistory[pod] ? this.failureHistory[pod] + 1 : 1;

      // Broadcast alert
      this.broadcast({
        type: 'alert',
        severity,
        pod,
        message: alert.message,
        impactScore: failureAnalysis.impactScore,
        cascadingPods: failureAnalysis.cascadingAffected
      });

      // Log alert
      console.log(`⚠️  [ALERT] ${severity.toUpperCase()}: Pod ${pod} failed`);
      console.log(`   Impact Score: ${failureAnalysis.impactScore}`);
      if (failureAnalysis.recommendations.length > 0) {
        console.log(`   Recommendations:`);
        failureAnalysis.recommendations.forEach(rec => console.log(`     → ${rec}`));
      }

      // Trigger auto-healing for critical failures
      if (severity === 'critical' && SelfHealingSystem.agentCallbacks) {
        console.log(`🔴 [AUTO-TRIGGER] Initiating emergency healing for critical pod failure: ${pod}`);
        // The main system should handle triggering the healing process
      }
    });

    this.currentState.alerts = this.alerts.slice(-10); // Keep last 10 alerts
  }

  getAlert(severity = null) {
    if (severity) {
      return this.alerts.filter(a => a.severity === severity);
    }
    return this.alerts;
  }

  dismissAlert(alertId) {
    this.alerts = this.alerts.filter(a => a.id !== alertId);
    this.currentState.alerts = this.alerts;
    this.broadcast({ type: 'state', data: this.currentState });
  }

  setRCAResult(rcaData) {
    this.currentState.rca = rcaData;
    this.currentState.rootCause = rcaData.rootCause;
    this.currentState.confidence = rcaData.confidence;
    this.currentState.chainDetails = rcaData.chainDetails;
    this.broadcast({ type: 'rca', data: rcaData });
    this.broadcast({ type: 'state', data: this.currentState });
  }

  setRunning(running) {
    this.isRunning = running;
  }
}

module.exports = DashboardServer;
