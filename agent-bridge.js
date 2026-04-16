#!/usr/bin/env node

/**
 * Agent Integration Bridge
 * Connects the Dashboard with the Self-Healing AI Agents
 *
 * This module bridges the gap between the mock metrics server
 * and the intelligent self-healing agents in ai_agents/
 */

const http = require('http');
const path = require('path');

// Import the self-healing system
const selfHealingPath = path.join(__dirname, 'ai_agents', 'self-healing-system', 'main.js');
let selfHealingSystem = null;

try {
  selfHealingSystem = require(selfHealingPath);
  console.log('✅ Self-healing agents loaded successfully');
} catch (error) {
  console.warn('⚠️  Self-healing agents not available:', error.message);
  console.log('   Falling back to built-in healing logic');
}

// Agent Bridge Server Configuration
const BRIDGE_PORT = process.env.BRIDGE_PORT || 5556;
const METRICS_URL = process.env.METRICS_URL || 'http://localhost:5555';

// Agent State
const agentState = {
  active: false,
  lastAnalysis: null,
  healingHistory: [],
  connectedAgents: {
    observer: 'idle',
    detector: 'idle',
    rca: 'idle',
    executor: 'idle'
  },
  metrics: null
};

/**
 * Fetch current metrics from the mock server
 */
async function fetchMetrics() {
  try {
    const response = await fetch(`${METRICS_URL}/api/metrics`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('Failed to fetch metrics:', error.message);
    return null;
  }
}

/**
 * Run the full AI agent analysis
 */
async function runAgentAnalysis(metrics) {
  if (!selfHealingSystem) {
    return runFallbackAnalysis(metrics);
  }

  try {
    agentState.connectedAgents.observer = 'running';
    agentState.connectedAgents.detector = 'running';
    agentState.connectedAgents.rca = 'running';
    agentState.connectedAgents.executor = 'running';

    // Configure the self-healing system
    selfHealingSystem.setMetricsUrl(METRICS_URL);

    // Run the self-healing system
    const result = await selfHealingSystem.runSelfHealingSystem({
      onAnalysis: (analysis) => {
        console.log('🔍 Observer analysis:', analysis.issues?.length || 0, 'issues found');
      },
      onDetection: (detection) => {
        console.log('🎯 Detector confirmed:', detection.confirmedIssues?.length || 0, 'issues');
      },
      onRCA: (rca) => {
        console.log('🔬 RCA complete:', rca.rootCause);
      }
    });

    // Update agent states
    agentState.connectedAgents.observer = 'idle';
    agentState.connectedAgents.detector = 'idle';
    agentState.connectedAgents.rca = 'idle';
    agentState.connectedAgents.executor = 'idle';

    return {
      success: result.success,
      issues: result.issuesFound || 0,
      fixes: result.fixesApplied || 0,
      attempts: result.attempts || 0,
      timeline: result.timeline || []
    };
  } catch (error) {
    console.error('Agent analysis failed:', error.message);
    return runFallbackAnalysis(metrics);
  }
}

/**
 * Fallback analysis when AI agents are not available
 */
function runFallbackAnalysis(metrics) {
  const issues = [];
  const actions = [];

  // Check for failed pods
  metrics.pods?.forEach(pod => {
    if (pod.status !== 'Running') {
      issues.push({
        pod: pod.name,
        status: pod.status,
        severity: pod.status === 'OOMKilled' ? 'critical' : 'high'
      });

      // Determine action based on status
      if (pod.status === 'CrashLoopBackOff' || pod.status === 'Failed') {
        actions.push({
          pod: pod.name,
          action: 'restart',
          reason: `Pod is in ${pod.status} state`,
          confidence: 0.95
        });
      } else if (pod.status === 'OOMKilled') {
        actions.push({
          pod: pod.name,
          action: 'scale',
          reason: 'Out of memory - scaling resources',
          confidence: 0.98
        });
      } else if (pod.status === 'Pending') {
        actions.push({
          pod: pod.name,
          action: 'scale',
          reason: 'Pod stuck in Pending state',
          confidence: 0.85
        });
      }
    }

    // Check for resource pressure
    if (pod.status === 'Running') {
      if (pod.cpu > 400) {
        actions.push({
          pod: pod.name,
          action: 'scale',
          reason: `High CPU usage (${pod.cpu}m)`,
          confidence: 0.82
        });
      }
      if (pod.memory > 1500) {
        actions.push({
          pod: pod.name,
          action: 'scale',
          reason: `High memory usage (${pod.memory}Mi)`,
          confidence: 0.88
        });
      }
    }
  });

  return {
    success: true,
    issues,
    actions,
    agent: 'fallback',
    timestamp: new Date().toISOString()
  };
}

/**
 * Execute healing actions
 */
async function executeHealing(actions) {
  const results = [];

  for (const action of actions) {
    try {
      let endpoint;
      if (action.action === 'restart') {
        endpoint = `/api/pods/${action.pod}/restart`;
      } else if (action.action === 'scale') {
        endpoint = `/api/pods/${action.pod}/scale`;
      } else {
        continue;
      }

      const response = await fetch(`${METRICS_URL}${endpoint}`, {
        method: 'POST'
      });

      const result = await response.json();
      results.push({
        pod: action.pod,
        action: action.action,
        success: result.success,
        message: result.message
      });
    } catch (error) {
      results.push({
        pod: action.pod,
        action: action.action,
        success: false,
        error: error.message
      });
    }
  }

  // Record in history
  agentState.healingHistory.push({
    timestamp: new Date().toISOString(),
    actions,
    results
  });

  // Keep only last 50 entries
  if (agentState.healingHistory.length > 50) {
    agentState.healingHistory = agentState.healingHistory.slice(-50);
  }

  return results;
}

// Create the bridge server
const server = http.createServer(async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /api/agents/status - Get agent status
  if (url.pathname === '/api/agents/status' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({
      agents: agentState.connectedAgents,
      active: agentState.active,
      lastAnalysis: agentState.lastAnalysis,
      healingHistory: agentState.healingHistory.slice(-10),
      metricsUrl: METRICS_URL,
      aiAgentsAvailable: !!selfHealingSystem
    }, null, 2));
    return;
  }

  // POST /api/agents/analyze - Trigger agent analysis
  if (url.pathname === '/api/agents/analyze' && req.method === 'POST') {
    agentState.active = true;
    const metrics = await fetchMetrics();

    if (!metrics) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'Failed to fetch metrics' }, null, 2));
      return;
    }

    const analysis = await runAgentAnalysis(metrics);
    agentState.lastAnalysis = analysis;
    agentState.active = false;

    res.writeHead(200);
    res.end(JSON.stringify(analysis, null, 2));
    return;
  }

  // POST /api/agents/heal - Trigger intelligent healing
  if (url.pathname === '/api/agents/heal' && req.method === 'POST') {
    const targetPod = url.searchParams.get('pod');
    const metrics = await fetchMetrics();

    if (!metrics) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'Failed to fetch metrics' }, null, 2));
      return;
    }

    // Run analysis
    const analysis = await runAgentAnalysis(metrics);

    // Filter actions if targetPod specified
    let actions = analysis.actions || [];
    if (targetPod) {
      actions = actions.filter(a => a.pod === targetPod);
    }

    // Execute healing
    const results = await executeHealing(actions);

    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      analysis,
      actions,
      results,
      timestamp: new Date().toISOString()
    }, null, 2));
    return;
  }

  // POST /api/agents/enable - Enable/disable auto-healing
  if (url.pathname === '/api/agents/enable' && req.method === 'POST') {
    const enabled = url.searchParams.get('enabled') === 'true';
    agentState.autoHealEnabled = enabled;

    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      autoHealEnabled: enabled,
      message: enabled ? 'Auto-healing enabled' : 'Auto-healing disabled'
    }, null, 2));
    return;
  }

  // GET / - Bridge info
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({
      name: 'Agent Integration Bridge',
      status: 'running',
      aiAgentsAvailable: !!selfHealingSystem,
      endpoints: [
        'GET  /api/agents/status',
        'POST /api/agents/analyze',
        'POST /api/agents/heal?pod=<name>',
        'POST /api/agents/enable?enabled=true|false'
      ]
    }, null, 2));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not Found' }, null, 2));
});

// Start the bridge server
server.listen(BRIDGE_PORT, () => {
  console.log(`\n🔗 Agent Integration Bridge running on http://localhost:${BRIDGE_PORT}`);
  console.log(`   AI Agents: ${selfHealingSystem ? '✅ Available' : '❌ Not Available'}`);
  console.log(`   Metrics: ${METRICS_URL}`);
  console.log('\n   Available endpoints:');
  console.log('   GET  /api/agents/status');
  console.log('   POST /api/agents/analyze');
  console.log('   POST /api/agents/heal?pod=<name>');
  console.log('   POST /api/agents/enable?enabled=true|false\n');
});

// Export for programmatic use
module.exports = {
  agentState,
  fetchMetrics,
  runAgentAnalysis,
  executeHealing
};
