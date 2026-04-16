const sampleIncident = {
  logs: ["request timeout", "connection refused from db"],
  metrics: { cpu: 0.51, memory: 0.49, latency: 0.72, error_rate: 0.28 },
  traces: ["checkout span slow"],
  dependency_graph: { checkout: ["database"] },
  deployment: { recent: false }
};

const incidentInput = document.getElementById("incidentInput");
const finalOutput = document.getElementById("finalOutput");
const runBtn = document.getElementById("runBtn");
const decisionBadge = document.getElementById("decisionBadge");

const observerList = document.getElementById("observerList");
const rootCauseList = document.getElementById("rootCauseList");
const deciderList = document.getElementById("deciderList");
const executionList = document.getElementById("executionList");

incidentInput.value = JSON.stringify(sampleIncident, null, 2);

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePercent(value) {
  const v = toNumber(value);
  return clamp01(v > 1 ? v / 100 : v);
}

function collectText(payload) {
  const logs = Array.isArray(payload.logs) ? payload.logs : [payload.logs].filter(Boolean);
  const traces = Array.isArray(payload.traces)
    ? payload.traces
    : [payload.traces].filter(Boolean);
  return [...logs, ...traces, JSON.stringify(payload.dependency_graph || {})].join("\n");
}

function hasPattern(text, patterns) {
  return patterns.some((pattern) => new RegExp(pattern, "i").test(text));
}

function score(impact, confidence, cost) {
  return clamp01(impact * confidence - cost);
}

function decision(rootCause, action, confidence, impact, cost, reasoning, step) {
  return {
    rootCause,
    action,
    confidence: clamp01(confidence),
    impact: clamp01(impact),
    cost: clamp01(cost),
    score: score(impact, confidence, cost),
    reasoning,
    step
  };
}

function step1Rulebook(payload) {
  const text = collectText(payload);
  const metrics = payload.metrics || {};
  const deployment = payload.deployment || {};
  const cpu = normalizePercent(metrics.cpu ?? metrics.cpu_utilization ?? 0);
  const errorRate = normalizePercent(metrics.error_rate ?? metrics.errors ?? 0);

  if (hasPattern(text, ["CrashLoopBackOff"])) {
    return decision(
      "Pod crash loop detected (CrashLoopBackOff).",
      "restart",
      0.98,
      0.75,
      0.2,
      "Rulebook match: CrashLoopBackOff maps directly to pod restart.",
      "STEP 1"
    );
  }

  if (hasPattern(text, ["OOMKilled"])) {
    return decision(
      "Container memory exhaustion (OOMKilled).",
      "scale",
      0.97,
      0.85,
      0.45,
      "Rulebook match: OOMKilled requires memory increase or scaling.",
      "STEP 1"
    );
  }

  if (cpu > 0.85) {
    return decision(
      "Sustained high CPU utilization above 85%.",
      "scale",
      0.92,
      0.8,
      0.45,
      "Rulebook match: high CPU indicates a scaling action.",
      "STEP 1"
    );
  }

  if (hasPattern(text, ["ImagePullBackOff"])) {
    return decision(
      "Container image retrieval failure (ImagePullBackOff).",
      "restart",
      0.95,
      0.6,
      0.2,
      "Rulebook match: fix image/config then restart deployment.",
      "STEP 1"
    );
  }

  const hasErrors = errorRate > 0.05 || hasPattern(text, ["error", "exception", "failed"]);
  if (Boolean(deployment.recent) && hasErrors) {
    return decision(
      "Recent deployment correlates with elevated errors.",
      "rollback",
      0.93,
      0.88,
      0.35,
      "Rulebook match: deployment-induced regression should be rolled back.",
      "STEP 1"
    );
  }

  return null;
}

function step2Regex(payload) {
  const text = collectText(payload);
  const checks = [
    {
      patterns: ["timeout", "connection refused"],
      rootCause: "Database/network connectivity instability.",
      action: "restart",
      confidence: 0.82,
      impact: 0.62,
      cost: 0.2,
      reasoning:
        "Strong log pattern for timeout/connection refusal indicates dependency reachability failure."
    },
    {
      patterns: ["OOMKilled"],
      rootCause: "Memory pressure causing process termination.",
      action: "scale",
      confidence: 0.9,
      impact: 0.84,
      cost: 0.45,
      reasoning: "Strong OOM pattern indicates memory remediation via scaling."
    },
    {
      patterns: ["segmentation fault", "panic"],
      rootCause: "Application runtime crash.",
      action: "restart",
      confidence: 0.8,
      impact: 0.66,
      cost: 0.2,
      reasoning: "Crash signatures detected in logs suggest app failure."
    },
    {
      patterns: ["rate limit", "throttling"],
      rootCause: "Throughput saturation or quota throttling.",
      action: "scale",
      confidence: 0.84,
      impact: 0.78,
      cost: 0.45,
      reasoning: "Rate limiting patterns generally improve with horizontal scaling."
    }
  ];

  for (const check of checks) {
    if (hasPattern(text, check.patterns)) {
      const d = decision(
        check.rootCause,
        check.action,
        check.confidence,
        check.impact,
        check.cost,
        check.reasoning,
        "STEP 2"
      );
      if (d.confidence > 0.7) {
        return d;
      }
    }
  }

  return null;
}

function classify(payload) {
  const metrics = payload.metrics || {};
  const deployment = payload.deployment || {};
  const text = collectText(payload);

  const cpu = normalizePercent(metrics.cpu ?? metrics.cpu_utilization ?? 0);
  const memory = normalizePercent(metrics.memory ?? metrics.memory_utilization ?? 0);
  const latency = normalizePercent(metrics.latency ?? metrics.latency_p95 ?? 0);
  const errorRate = normalizePercent(metrics.error_rate ?? metrics.errors ?? 0);

  const dbSignal = hasPattern(text, ["db", "database", "query slow", "lock wait", "timeout"])
    ? 1
    : 0;
  const networkSignal = hasPattern(text, ["connection refused", "unreachable", "dns", "timeout"])
    ? 1
    : 0;
  const oomSignal = hasPattern(text, ["oomkilled", "out of memory"]) ? 1 : 0;
  const deploySignal = Boolean(deployment.recent) ? 1 : 0;

  const categories = {
    "CPU bottleneck": clamp01(0.75 * cpu + 0.25 * errorRate),
    "Memory issue": clamp01(0.7 * memory + 0.3 * oomSignal),
    "Database latency": clamp01(0.65 * latency + 0.35 * dbSignal),
    "Network issue": clamp01(0.6 * networkSignal + 0.4 * latency),
    "Deployment issue": clamp01(0.6 * deploySignal + 0.4 * errorRate)
  };

  let topCategory = "CPU bottleneck";
  for (const name of Object.keys(categories)) {
    if (categories[name] > categories[topCategory]) {
      topCategory = name;
    }
  }

  const actionMap = {
    "CPU bottleneck": "scale",
    "Memory issue": "scale",
    "Database latency": "restart",
    "Network issue": "restart",
    "Deployment issue": "rollback"
  };

  const impactMap = {
    "CPU bottleneck": 0.82,
    "Memory issue": 0.84,
    "Database latency": 0.68,
    "Network issue": 0.64,
    "Deployment issue": 0.9
  };

  const costMap = {
    restart: 0.2,
    scale: 0.45,
    rollback: 0.35
  };

  return {
    category: topCategory,
    confidence: categories[topCategory],
    action: actionMap[topCategory],
    impact: impactMap[topCategory],
    cost: costMap[actionMap[topCategory]]
  };
}

function step3Classifier(payload) {
  const c = classify(payload);
  const d = decision(
    c.category,
    c.action,
    c.confidence,
    c.impact,
    c.cost,
    `ML-style classification selected '${c.category}' with action '${c.action}'.`,
    "STEP 3"
  );

  if (d.confidence >= 0.7) {
    return d;
  }

  return null;
}

function step4Fallback(payload) {
  const metrics = payload.metrics || {};
  const cpu = normalizePercent(metrics.cpu ?? metrics.cpu_utilization ?? 0);
  const memory = normalizePercent(metrics.memory ?? metrics.memory_utilization ?? 0);
  const latency = normalizePercent(metrics.latency ?? metrics.latency_p95 ?? 0);
  const errorRate = normalizePercent(metrics.error_rate ?? metrics.errors ?? 0);

  const weightedPressure = 0.3 * cpu + 0.25 * memory + 0.25 * latency + 0.2 * errorRate;

  if (weightedPressure > 0.75) {
    return decision(
      "Mixed saturation signals with high overall pressure.",
      "scale",
      0.58,
      0.7,
      0.45,
      "Fallback reasoning due to low confidence/conflicting signals.",
      "STEP 4"
    );
  }

  if (errorRate > 0.35) {
    return decision(
      "Conflicting telemetry but elevated error profile after change window.",
      "rollback",
      0.58,
      0.78,
      0.35,
      "Fallback reasoning due to low confidence/conflicting signals.",
      "STEP 4"
    );
  }

  return decision(
    "Ambiguous signals; low-cost service recovery attempt preferred.",
    "restart",
    0.58,
    0.55,
    0.2,
    "Fallback reasoning due to low confidence/conflicting signals.",
    "STEP 4"
  );
}

function runPipeline(payload) {
  const step1 = step1Rulebook(payload);
  if (step1) {
    return { decision: step1, route: ["STEP 1 matched", "Pipeline stopped"] };
  }

  const step2 = step2Regex(payload);
  if (step2) {
    return { decision: step2, route: ["STEP 1 no match", "STEP 2 matched", "Pipeline stopped"] };
  }

  const step3 = step3Classifier(payload);
  if (step3) {
    return {
      decision: step3,
      route: ["STEP 1 no match", "STEP 2 low confidence/no match", "STEP 3 matched", "Pipeline stopped"]
    };
  }

  return {
    decision: step4Fallback(payload),
    route: ["STEP 1 no match", "STEP 2 low confidence/no match", "STEP 3 confidence < 0.7", "STEP 4 fallback"]
  };
}

function setList(node, items) {
  node.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    node.appendChild(li);
  }
}

function render(payload, result) {
  const d = result.decision;
  finalOutput.textContent = [
    `Root Cause: ${d.rootCause}`,
    `Action: ${d.action}`,
    `Confidence: ${d.confidence.toFixed(2)}`,
    `Impact: ${d.impact.toFixed(2)}`,
    `Cost: ${d.cost.toFixed(2)}`,
    `Score: ${d.score.toFixed(2)}`,
    `Reasoning: ${d.reasoning}`
  ].join("\n");

  decisionBadge.textContent = `${d.step} • ${d.action.toUpperCase()}`;
  decisionBadge.className = d.confidence >= 0.7 ? "badge good" : "badge warn";

  const metrics = payload.metrics || {};
  setList(observerList, [
    `Logs inspected: ${Array.isArray(payload.logs) ? payload.logs.length : 0}`,
    `CPU=${normalizePercent(metrics.cpu ?? metrics.cpu_utilization ?? 0).toFixed(2)} | Memory=${normalizePercent(
      metrics.memory ?? metrics.memory_utilization ?? 0
    ).toFixed(2)}`,
    `Latency=${normalizePercent(metrics.latency ?? metrics.latency_p95 ?? 0).toFixed(2)} | ErrorRate=${normalizePercent(
      metrics.error_rate ?? metrics.errors ?? 0
    ).toFixed(2)}`,
    `Recent deployment: ${Boolean((payload.deployment || {}).recent)}`
  ]);

  setList(rootCauseList, [
    "Rulebook evaluated in strict priority.",
    "Regex patterns checked: timeout, connection refused, OOMKilled, panic, throttling.",
    `Winning route: ${result.route.join(" -> ")}`,
    `Root cause hypothesis: ${d.rootCause}`
  ]);

  setList(deciderList, [
    `Action selected: ${d.action}`,
    `Confidence=${d.confidence.toFixed(2)}, Impact=${d.impact.toFixed(2)}, Cost=${d.cost.toFixed(2)}`,
    `Score=(Impact x Confidence)-Cost=${d.score.toFixed(2)}`,
    `LLM fallback used: ${d.step === "STEP 4" ? "Yes (simulated)" : "No"}`
  ]);

  setList(executionList, [
    `Execute ${d.action} plan on target deployment.`,
    d.action === "scale" ? "Increase replicas or memory limits." : "Roll out command to stabilize service quickly.",
    `Expected improvement signal: ${Math.round(d.impact * 100)}%`,
    `Risk footprint estimate: ${Math.round(d.cost * 100)}%`
  ]);
}

function onRun() {
  try {
    const payload = JSON.parse(incidentInput.value);
    const result = runPipeline(payload);
    render(payload, result);
  } catch (error) {
    decisionBadge.textContent = "Invalid JSON";
    decisionBadge.className = "badge warn";
    finalOutput.textContent = `Input Error: ${error.message}`;
    setList(observerList, ["Fix JSON input and retry."]);
    setList(rootCauseList, []);
    setList(deciderList, []);
    setList(executionList, []);
  }
}

runBtn?.addEventListener("click", onRun);

// ============================================
// INTELLIGENT SELF-HEALING DASHBOARD
// ============================================

const MetricsDashboard = {
  data: null,
  refreshInterval: null,
  isConnected: false,
  metricsUrl: 'http://localhost:5555/api/metrics',
  healthUrl: 'http://localhost:5555/api/health',
  healUrl: 'http://localhost:5555/api/heal',
  autoHealEnabled: false,
  failedPodsHistory: new Set(),
  healingHistory: [],
  lastHealingCheck: 0,

  init() {
    this.setupTabs();
    this.setupEventListeners();
    this.startAutoRefresh();
    this.fetchMetrics();
    this.fetchHealth();
  },

  setupTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = btn.dataset.tab;
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`${tabId}-tab`).classList.add('active');
      });
    });
  },

  setupEventListeners() {
    const refreshBtn = document.getElementById('refreshMetricsBtn');
    const filterInput = document.getElementById('podFilter');
    const autoHealBtn = document.getElementById('autoHealBtn');
    const resetAllBtn = document.getElementById('resetAllBtn');

    refreshBtn?.addEventListener('click', () => {
      this.fetchMetrics();
      this.fetchHealth();
    });

    filterInput?.addEventListener('input', (e) => this.filterPods(e.target.value));

    autoHealBtn?.addEventListener('click', () => {
      this.toggleAutoHeal();
    });

    resetAllBtn?.addEventListener('click', () => this.resetAllPods());
  },

  async toggleAutoHeal() {
    this.autoHealEnabled = !this.autoHealEnabled;
    const autoHealBtn = document.getElementById('autoHealBtn');

    if (this.autoHealEnabled) {
      autoHealBtn.textContent = '🛑 Stop Auto-Heal';
      autoHealBtn.classList.add('active');
      this.showNotification('🤖 Auto-healing enabled - Agent will automatically fix issues', 'info');

      // Immediately check for issues
      await this.performIntelligentHealing();
    } else {
      autoHealBtn.textContent = '🤖 Enable Auto-Heal';
      autoHealBtn.classList.remove('active');
      this.showNotification('Auto-healing disabled', 'info');
    }
  },

  async fetchMetrics() {
    const statusIndicator = document.getElementById('connectionStatus');
    const statusText = document.getElementById('connectionText');

    statusText.textContent = 'Fetching...';
    statusIndicator.className = 'status-indicator connecting';

    try {
      const response = await fetch(this.metricsUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      this.data = await response.json();
      this.isConnected = true;

      statusIndicator.className = 'status-indicator connected';
      statusText.textContent = 'Connected';

      this.updateDashboard();

      // Check for failed pods and trigger auto-heal if enabled
      if (this.autoHealEnabled) {
        this.checkAndHealPods();
      }
    } catch (error) {
      console.error('Failed to fetch metrics:', error);
      this.isConnected = false;
      statusIndicator.className = 'status-indicator disconnected';
      statusText.textContent = 'Disconnected - Check if server is running on port 5555';
      this.showDisconnectedState();
    }
  },

  async fetchHealth() {
    try {
      const response = await fetch(this.healthUrl);
      if (!response.ok) return;

      const health = await response.json();
      this.updateHealthPanel(health);
    } catch (error) {
      console.error('Failed to fetch health:', error);
    }
  },

  updateHealthPanel(health) {
    // Update cluster status with health score
    const clusterStatusBadge = document.getElementById('clusterStatusBadge');
    if (clusterStatusBadge && health.healthScore !== undefined) {
      const score = Math.round(health.healthScore);
      clusterStatusBadge.textContent = `Health: ${score}%`;
      clusterStatusBadge.className = 'badge ' + (score >= 80 ? 'good' : score >= 50 ? 'warn' : 'critical');
    }
  },

  async performIntelligentHealing(targetPod = null) {
    try {
      this.showNotification('🤖 Agent analyzing and healing...', 'info');

      const url = targetPod ? `${this.healUrl}?pod=${targetPod}` : this.healUrl;
      const response = await fetch(url, { method: 'POST' });
      const result = await response.json();

      if (result.success) {
        // Update SRE pipeline UI with healing results
        this.updateSREPipelineWithHealing(result);

        // Show healing summary
        if (result.actions && result.actions.length > 0) {
          result.actions.forEach(action => {
            this.showNotification(
              `🔧 ${action.action.toUpperCase()}: ${action.pod} - ${action.reason}`,
              'success'
            );
          });
          this.healingHistory.push(...result.actions);
        }

        // Refresh metrics to show updated state
        setTimeout(() => this.fetchMetrics(), 1000);
      } else {
        this.showNotification('No healing actions needed', 'info');
      }

      return result;
    } catch (error) {
      console.error('Healing failed:', error);
      this.showNotification('Healing failed: ' + error.message, 'error');
    }
  },

  updateSREPipelineWithHealing(result) {
    // Create incident data from healing actions
    const incidentData = {
      logs: result.actions?.map(a => `${a.pod}: ${a.reason}`) || ['Healing performed'],
      metrics: { cpu: 0.3, memory: 0.4, latency: 0.5, error_rate: 0.1 },
      traces: result.results?.map(r => r.message) || ['Self-healing executed'],
      dependency_graph: { 'self-healing-agent': ['cluster'] },
      deployment: { recent: true }
    };

    // Switch to pipeline tab and populate
    document.querySelector('.tab-btn[data-tab="pipeline"]')?.click();
    incidentInput.value = JSON.stringify(incidentData, null, 2);
    onRun();
  },

  async checkAndHealPods() {
    if (!this.data?.pods) return;

    const now = Date.now();
    // Don't heal more frequently than every 5 seconds
    if (now - this.lastHealingCheck < 5000) return;
    this.lastHealingCheck = now;

    const failedPods = this.data.pods.filter(p =>
      p.status === 'Failed' || p.status === 'CrashLoopBackOff' || p.status === 'OOMKilled' || p.status === 'Pending'
    );

    if (failedPods.length > 0) {
      console.log(`🤖 Auto-healing ${failedPods.length} failed pod(s)`);
      await this.performIntelligentHealing();
    }
  },

  async controlPod(podName, action, failureType = 'CrashLoopBackOff') {
    try {
      const endpoints = {
        kill: `/api/pods/${podName}/kill?type=${failureType}`,
        stop: `/api/pods/${podName}/stop`,
        restart: `/api/pods/${podName}/restart`,
        scale: `/api/pods/${podName}/scale`
      };

      let endpoint = endpoints[action];
      if (action === 'scale' && typeof failureType === 'number') {
        endpoint = `/api/pods/${podName}/scale?factor=${failureType}`;
      }

      const response = await fetch(`http://localhost:5555${endpoint}`, {
        method: 'POST'
      });

      const result = await response.json();

      if (result.success) {
        this.showNotification(`${action.toUpperCase()}: ${result.message}`, 'success');

        // If this was a healing action, update the SRE pipeline UI
        if (action === 'restart' || action === 'scale' || action === 'stop') {
          this.updateSREAgentsWithAction(podName, action, result);
        }

        // Refresh metrics
        setTimeout(() => this.fetchMetrics(), 500);
      } else {
        this.showNotification(`Error: ${result.error}`, 'error');
      }
    } catch (error) {
      this.showNotification(`Failed to ${action} ${podName}: ${error.message}`, 'error');
    }
  },

  async resetAllPods() {
    try {
      const response = await fetch('http://localhost:5555/api/control/reset', {
        method: 'POST'
      });
      const result = await response.json();

      if (result.success) {
        this.showNotification('All pods reset to Running state', 'success');
        this.failedPodsHistory.clear();
        this.healingHistory = [];
        this.fetchMetrics();
      }
    } catch (error) {
      this.showNotification('Failed to reset pods', 'error');
    }
  },

  updateSREAgentsWithAction(podName, action, apiResult) {
    // Create incident data from the pod
    const incidentData = {
      logs: [`Pod ${podName} was ${action}ed`, apiResult.message],
      metrics: { cpu: 0.3, memory: 0.4, latency: 0.5, error_rate: 0.1 },
      traces: [`${podName} container ${action}`],
      dependency_graph: { [podName]: ['cluster'] },
      deployment: { recent: true }
    };

    // Switch to pipeline tab and populate
    document.querySelector('.tab-btn[data-tab="pipeline"]')?.click();
    incidentInput.value = JSON.stringify(incidentData, null, 2);
    onRun();
  },

  showNotification(message, type = 'info') {
    // Remove existing notification
    const existing = document.querySelector('.notification-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `notification-toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('show');
    }, 10);

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },

  startAutoRefresh() {
    this.refreshInterval = setInterval(() => {
      this.fetchMetrics();
      this.fetchHealth();
    }, 5000);
  },

  stopAutoRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  },

  updateDashboard() {
    if (!this.data) return;
    this.updateClusterStats();
    this.updateResourceUsage();
    this.updateNodesList();
    this.updatePodsList();
    this.updateAlertsList();
    this.updateControlPanel();
  },

  updateClusterStats() {
    const cluster = this.data.cluster || {};
    const pods = this.data.pods || [];
    const resources = this.data.resources || {};

    // Compute pod health from live pod list to keep cards and counters in sync.
    const running = pods.filter(p => (p.status || '').toLowerCase() === 'running').length;
    const failed = pods.filter(p => {
      const s = (p.status || '').toLowerCase();
      return s.includes('failed') || s.includes('crashloop') || s.includes('oomkilled') || s.includes('error') || s.includes('stopped');
    }).length;
    const pending = pods.filter(p => (p.status || '').toLowerCase().includes('pending')).length;
    const totalPods = pods.length || cluster.pods_total || 0;

    document.getElementById('totalNodes').textContent = cluster.nodes || 0;
    document.getElementById('totalPods').textContent = totalPods;
    document.getElementById('runningPods').textContent = running;
    document.getElementById('failedPods').textContent = failed + pending;

    const statusBadge = document.getElementById('clusterStatusBadge');
    const isHealthy = failed + pending === 0;
    statusBadge.textContent = isHealthy ? 'HEALTHY' : 'UNHEALTHY';
    statusBadge.className = `badge ${isHealthy ? 'good' : 'warn'}`;

    this.updateResourceBar('cpu', resources.cpu_usage_percent);
    this.updateResourceBar('memory', resources.memory_usage_percent);
    this.updateResourceBar('storage', resources.storage_usage_percent);
  },

  updateResourceBar(type, value) {
    const bar = document.getElementById(`${type}Bar`);
    const valueText = document.getElementById(`${type}Value`);

    if (bar && valueText && value !== undefined) {
      const percentage = Math.round(value);
      bar.style.width = `${percentage}%`;
      bar.className = 'resource-fill';
      if (percentage > 80) bar.classList.add('critical');
      else if (percentage > 60) bar.classList.add('warning');
      else bar.classList.add('healthy');
      valueText.textContent = `${percentage}%`;
    }
  },

  updateNodesList() {
    const nodesList = document.getElementById('nodesList');
    const nodes = this.data.nodes || [];
    const nodesCount = document.getElementById('nodesCount');

    nodesCount.textContent = `${nodes.length} nodes`;

    if (nodes.length === 0) {
      nodesList.innerHTML = '<p class="empty-text">No nodes data available</p>';
      return;
    }

    nodesList.innerHTML = nodes.map(node => {
      const statusClass = node.status === 'Ready' ? 'healthy' : 'critical';
      const cpuClass = node.cpu > 70 ? 'warning' : 'healthy';
      const memClass = node.memory > 80 ? 'warning' : 'healthy';

      return `
        <div class="node-card ${statusClass}">
          <div class="node-header">
            <span class="node-name">${node.name}</span>
            <span class="node-status ${statusClass}">${node.status}</span>
          </div>
          <div class="node-metrics">
            <div class="node-metric">
              <span class="metric-label">CPU</span>
              <div class="mini-bar">
                <div class="mini-fill ${cpuClass}" style="width: ${node.cpu}%"></div>
              </div>
              <span class="metric-value">${node.cpu}%</span>
            </div>
            <div class="node-metric">
              <span class="metric-label">Memory</span>
              <div class="mini-bar">
                <div class="mini-fill ${memClass}" style="width: ${node.memory}%"></div>
              </div>
              <span class="metric-value">${node.memory}%</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  },

  updatePodsList() {
    const podsGrid = document.getElementById('podsGrid');
    const pods = this.data.pods || [];
    const podsCount = document.getElementById('podsCount');

    podsCount.textContent = `${pods.length} pods`;

    if (pods.length === 0) {
      podsGrid.innerHTML = '<p class="empty-text">No pods data available</p>';
      return;
    }

    this.renderPods(pods);
  },

  renderPods(pods) {
    const podsGrid = document.getElementById('podsGrid');

    podsGrid.innerHTML = pods.map(pod => {
      let statusClass = 'healthy';
      let statusIcon = '✅';
      if (pod.status === 'Failed' || pod.status === 'CrashLoopBackOff') {
        statusClass = 'critical';
        statusIcon = '❌';
      } else if (pod.status === 'OOMKilled') {
        statusClass = 'critical';
        statusIcon = '💥';
      } else if (pod.status === 'Pending') {
        statusClass = 'warning';
        statusIcon = '⏳';
      }

      const isRunning = pod.status === 'Running';
      const showHealButton = !isRunning && this.data?.healing?.active;

      return `
        <div class="pod-card ${statusClass}" data-pod-name="${pod.name}">
          <div class="pod-header">
            <div class="pod-info">
              <span class="pod-name">${statusIcon} ${pod.name}</span>
              <span class="pod-namespace">${pod.namespace}</span>
            </div>
            <span class="pod-status ${statusClass}">${pod.status}</span>
          </div>
          <div class="pod-metrics">
            <div class="pod-metric">
              <span class="metric-label">CPU</span>
              <span class="metric-value">${pod.cpu}m</span>
            </div>
            <div class="pod-metric">
              <span class="metric-label">Memory</span>
              <span class="metric-value">${pod.memory}Mi</span>
            </div>
            <div class="pod-metric">
              <span class="metric-label">Replicas</span>
              <span class="metric-value">${pod.replicas || 1}</span>
            </div>
          </div>
          ${pod.containers ? `
            <div class="containers-list">
              ${pod.containers.map(c => `
                <div class="container-item">
                  <span class="container-name">${c.name}</span>
                  <span class="container-status ${c.status?.toLowerCase() || 'running'}">${c.status || 'Running'}</span>
                </div>
              `).join('')}
            </div>
          ` : ''}
          <div class="pod-actions">
            ${isRunning ? `
              <div class="kill-section">
                <select class="failure-type-select" data-pod="${pod.name}">
                  <option value="CrashLoopBackOff">CrashLoopBackOff</option>
                  <option value="Failed">Failed</option>
                  <option value="Pending">Pending</option>
                  <option value="OOMKilled">OOMKilled</option>
                </select>
                <button class="btn-kill" data-pod="${pod.name}">💥 Kill</button>
                <button class="btn-stop" data-pod="${pod.name}">⏹ Stop</button>
              </div>
            ` : `
              <div class="heal-section">
                <span class="issue-badge ${statusClass}">${pod.status}</span>
                <button class="btn-heal" data-pod="${pod.name}">🔧 Heal</button>
              </div>
            `}
            <button class="btn-scale-up" data-pod="${pod.name}">📈 Scale Up</button>
            <button class="btn-scale-down" data-pod="${pod.name}">📉 Scale Down</button>
          </div>
        </div>
      `;
    }).join('');

    // Add event listeners
    podsGrid.querySelectorAll('.btn-kill').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const podName = e.target.dataset.pod;
        const failureType = podsGrid.querySelector(`select[data-pod="${podName}"]`).value;
        this.controlPod(podName, 'kill', failureType);
      });
    });

    podsGrid.querySelectorAll('.btn-heal').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const podName = e.target.dataset.pod;
        this.performIntelligentHealing(podName);
      });
    });

    podsGrid.querySelectorAll('.btn-stop').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.controlPod(e.target.dataset.pod, 'stop');
      });
    });

    podsGrid.querySelectorAll('.btn-scale-up').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.controlPod(e.target.dataset.pod, 'scale', 1.5);
      });
    });

    podsGrid.querySelectorAll('.btn-scale-down').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.controlPod(e.target.dataset.pod, 'scale', 0.8);
      });
    });
  },

  updateControlPanel() {
    const failedPods = this.data.pods?.filter(p =>
      p.status !== 'Running'
    ) || [];

    const srePanel = document.getElementById('sreAnalysisPanel');
    if (srePanel) {
      if (failedPods.length > 0) {
        // Generate SRE analysis for each failed pod
        const analyses = failedPods.map(pod => {
          const payload = {
            logs: [`${pod.name} is in ${pod.status} state`, `container ${pod.containers?.[0]?.status || 'failed'}`],
            metrics: { cpu: pod.cpu / 1000, memory: pod.memory / 2048, latency: 0.8, error_rate: 0.5 },
            traces: [`${pod.name} failure detected`],
            dependency_graph: { [pod.name]: ['cluster'] },
            deployment: { recent: false }
          };

          const result = runPipeline(payload);
          return { pod: pod.name, status: pod.status, ...result.decision };
        });

        srePanel.innerHTML = `
          <div class="sre-header">
            <h3>🔍 SRE Agent Analysis</h3>
            <span class="badge warn">${failedPods.length} issues found</span>
          </div>
          <div class="sre-actions">
            <button class="btn-heal-all" id="healAllBtn">🔧 Heal All Issues</button>
          </div>
          ${analyses.map(a => `
            <div class="sre-analysis-item">
              <div class="sre-pod-header">
                <span class="sre-pod-name">${a.pod}</span>
                <span class="pod-status-badge ${a.status.toLowerCase()}">${a.status}</span>
              </div>
              <div class="sre-recommendation">
                <span class="badge ${a.confidence >= 0.7 ? 'good' : 'warn'}">${a.action.toUpperCase()}</span>
                <span class="sre-confidence">${(a.confidence * 100).toFixed(0)}% confidence</span>
              </div>
              <div class="sre-reasoning">${a.reasoning}</div>
              <button class="btn-execute-sre" data-pod="${a.pod}" data-action="${a.action}">
                ▶ Execute ${a.action}
              </button>
            </div>
          `).join('')}
        `;

        // Add event listeners
        document.getElementById('healAllBtn')?.addEventListener('click', () => {
          this.performIntelligentHealing();
        });

        srePanel.querySelectorAll('.btn-execute-sre').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const podName = e.target.dataset.pod;
            const action = e.target.dataset.action;
            if (action === 'scale') {
              this.controlPod(podName, 'scale');
            } else {
              this.controlPod(podName, 'restart');
            }
          });
        });
      } else {
        // Show healing history if available
        const hasHistory = this.healingHistory.length > 0;
        srePanel.innerHTML = `
          <div class="sre-header">
            <h3>🔍 SRE Agent Analysis</h3>
            <span class="badge good">All healthy</span>
          </div>
          <p class="empty-text">All services running normally - no action required</p>
          ${hasHistory ? `
            <div class="healing-history">
              <h4>Recent Healing Actions</h4>
              ${this.healingHistory.slice(-5).map(h => `
                <div class="history-item">
                  <span class="history-action">${h.action}</span>
                  <span class="history-pod">${h.pod}</span>
                </div>
              `).join('')}
            </div>
          ` : ''}
        `;
      }
    }
  },

  filterPods(filter) {
    if (!this.data?.pods) return;
    const lowerFilter = filter.toLowerCase();
    const filtered = this.data.pods.filter(pod =>
      pod.name.toLowerCase().includes(lowerFilter) ||
      pod.namespace.toLowerCase().includes(lowerFilter) ||
      pod.status.toLowerCase().includes(lowerFilter)
    );
    this.renderPods(filtered);
  },

  updateAlertsList() {
    const alertsList = document.getElementById('alertsList');
    const alerts = this.data.alerts || [];
    const alertsCount = document.getElementById('alertsCount');

    alertsCount.textContent = `${alerts.length} alerts`;

    if (alerts.length === 0) {
      alertsList.innerHTML = '<p class="empty-text">No active alerts</p>';
      return;
    }

    alertsList.innerHTML = alerts.map(alert => {
      const severityClass = alert.severity || 'info';
      return `
        <div class="alert-item ${severityClass}">
          <div class="alert-header">
            <span class="alert-severity ${severityClass}">${alert.severity?.toUpperCase() || 'INFO'}</span>
            <span class="alert-time">${new Date(alert.timestamp).toLocaleTimeString()}</span>
          </div>
          <div class="alert-message">${alert.message}</div>
          ${alert.pod ? `<button class="btn-quick-heal" data-pod="${alert.pod}">🔧 Heal</button>` : ''}
        </div>
      `;
    }).join('');

    // Add quick heal buttons
    alertsList.querySelectorAll('.btn-quick-heal').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const podName = e.target.dataset.pod;
        this.performIntelligentHealing(podName);
      });
    });
  },

  showDisconnectedState() {
    document.getElementById('clusterStatusBadge').textContent = 'OFFLINE';
    document.getElementById('clusterStatusBadge').className = 'badge warn';

    document.getElementById('totalNodes').textContent = '-';
    document.getElementById('totalPods').textContent = '-';
    document.getElementById('runningPods').textContent = '-';
    document.getElementById('failedPods').textContent = '-';

    ['cpu', 'memory', 'storage'].forEach(type => {
      document.getElementById(`${type}Bar`).style.width = '0%';
      document.getElementById(`${type}Value`).textContent = '-';
    });

    document.getElementById('nodesList').innerHTML = `
      <div class="connection-error">
        <p>Unable to connect to metrics server</p>
        <p class="error-hint">Start the server with: node mock-metrics-server.js</p>
      </div>
    `;
    document.getElementById('podsGrid').innerHTML = '<p class="empty-text">No data available</p>';
    document.getElementById('alertsList').innerHTML = '<p class="empty-text">No data available</p>';
  }
};

// ============================================
// INITIALIZATION
// ============================================

if (runBtn) {
  onRun();
}

document.addEventListener('DOMContentLoaded', () => {
  MetricsDashboard.init();
});

window.addEventListener('beforeunload', () => {
  MetricsDashboard.stopAutoRefresh();
});
