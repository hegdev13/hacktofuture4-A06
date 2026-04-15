/**
 * Dashboard Application
 * Real-time monitoring and control for Self-Healing System
 */

class DashboardApp {
  constructor() {
    this.eventSource = null;
    this.currentPage = 'dashboard';
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
      metricsUrl: localStorage.getItem('metricsUrl') || ''
    };
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.isRunning = false;

    this.init();
  }

  init() {
    this.connectEventSource();
    this.setupNavigation();
    this.setupConfigPanel();
    this.setupKeyboardShortcuts();
    this.fetchInitialState();

    // Load saved metrics URL or auto-set ngrok URL
    const input = document.getElementById('metricsUrl');
    if (input) {
      if (this.currentState.metricsUrl) {
        input.value = this.currentState.metricsUrl;
      } else {
        // Auto-set the ngrok URL
        input.value = 'https://refocus-cement-spud.ngrok-free.dev/pods';
      }
    }

    console.log('🔧 Self-Healing Dashboard initialized');
  }

  /**
   * Connect to Server-Sent Events
   */
  connectEventSource() {
    if (this.eventSource) {
      this.eventSource.close();
    }

    try {
      this.eventSource = new EventSource('/api/events');

      this.eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          this.handleUpdate(data);
        } catch (err) {
          console.error('Failed to parse SSE data:', err);
        }
      };

      this.eventSource.onopen = () => {
        console.log('✅ Connected to event stream');
        this.reconnectAttempts = 0;
      };

      this.eventSource.onerror = (err) => {
        console.error('EventSource error:', err);
        this.eventSource.close();

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
          console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
          setTimeout(() => this.connectEventSource(), delay);
        }
      };
    } catch (err) {
      console.error('Failed to create EventSource:', err);
    }
  }

  /**
   * Handle incoming updates
   */
  handleUpdate(data) {
    switch (data.type) {
      case 'state':
        this.updateState(data.data);
        // Also check for RCA data in state
        if (data.data.rca) {
          this.updateRCADisplay(data.data.rca);
        }
        break;
      case 'agent':
        this.updateAgentStatus(data.agent, data.status);
        break;
      case 'timeline':
        this.addTimelineEvent(data.data);
        break;
      case 'rca':
        this.updateRCADisplay(data.data);
        break;
      case 'alert':
        this.handleAlert(data);
        break;
      default:
        console.log('Unknown update type:', data.type);
    }
  }

  /**
   * Fetch initial state
   */
  async fetchInitialState() {
    try {
      const response = await fetch('/api/state');
      if (response.ok) {
        const state = await response.json();
        this.updateState(state);
      }
    } catch (err) {
      console.error('Failed to fetch initial state:', err);
    }
  }

  /**
   * Update full state
   */
  updateState(state) {
    this.currentState = { ...this.currentState, ...state };

    // Update health indicator
    this.updateHealthIndicator();

    // Update stats
    this.updateStats();

    // Update issues
    this.updateIssuesList();

    // Update pods list
    this.updatePodsList();

    // Update alerts
    this.updateAlertsList();

    // Update dependency graph
    this.drawDependencyGraph();

    // Update agents
    this.updateAllAgents();

    // Update timeline if present
    if (state.timeline && state.timeline.length > 0) {
      this.updateTimeline();
    }
  }

  /**
   * Update health indicator
   */
  updateHealthIndicator() {
    const indicator = document.getElementById('healthIndicator');
    if (!indicator) return;

    const { healthy, issues } = this.currentState;
    const hasHighSeverity = issues.some(i => i.severity === 'high');

    indicator.className = 'health-indicator';

    if (healthy) {
      indicator.classList.add('healthy');
      indicator.innerHTML = '<div class="pulse-dot"></div><span>Healthy</span>';
    } else if (hasHighSeverity) {
      indicator.classList.add('unhealthy');
      indicator.innerHTML = '<div class="pulse-dot"></div><span>Critical</span>';
    } else {
      indicator.classList.add('degraded');
      indicator.innerHTML = '<div class="pulse-dot"></div><span>Degraded</span>';
    }
  }

  /**
   * Update stats
   */
  updateStats() {
    const issuesEl = document.getElementById('totalIssues');
    const successRateEl = document.getElementById('successRate');
    const learningsEl = document.getElementById('totalLearnings');

    if (issuesEl) {
      const issueCount = this.currentState.issues?.length || 0;
      issuesEl.textContent = issueCount;
      const changeEl = issuesEl.parentElement.querySelector('.stat-change');
      if (changeEl) {
        changeEl.textContent = issueCount === 0 ? 'No active issues' : `${issueCount} issues detected`;
      }
    }

    if (successRateEl) {
      const rate = this.currentState.memory?.successRate || 100;
      successRateEl.textContent = `${rate}%`;
    }

    if (learningsEl) {
      const learnings = this.currentState.memory?.totalLearnings || 0;
      learningsEl.textContent = learnings;
    }
  }

  /**
   * Update issues list
   */
  updateIssuesList() {
    const container = document.getElementById('issuesList');
    const countEl = document.getElementById('issueCount');
    if (!container) return;

    const issues = this.currentState.issues || [];

    if (countEl) {
      countEl.textContent = issues.length;
    }

    if (issues.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">✅</div>
          <div class="empty-state-title">All Systems Operational</div>
          <p>No active issues detected. Click "Run Self-Healing" to start a scan.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = issues.map(issue => `
      <div class="issue-item">
        <div class="issue-severity ${issue.severity || 'low'}"></div>
        <div class="issue-content">
          <div class="issue-title">${issue.target || issue.pod || issue.node || 'Unknown'}</div>
          <div class="issue-description">${issue.problem}</div>
          <div class="issue-meta">
            <span class="issue-tag">${issue.type}</span>
            <span class="issue-tag">${issue.severity}</span>
            ${issue.metric ? `<span class="issue-tag">${issue.metric}: ${issue.value || 'N/A'}</span>` : ''}
          </div>
        </div>
      </div>
    `).join('');
  }

  /**
   * Update pods list from raw metrics data
   */
  updatePodsList() {
    const container = document.getElementById('podsList');
    if (!container) return;

    // Get pods from multiple possible sources
    let pods = [];

    // Try to get from state.raw.pods (metrics data from server)
    if (this.currentState.raw && Array.isArray(this.currentState.raw.pods)) {
      pods = this.currentState.raw.pods;
    }
    // Also check state.pods directly
    else if (Array.isArray(this.currentState.pods)) {
      pods = this.currentState.pods;
    }
    // Fallback to cached pods
    else if (this.lastPods && this.lastPods.length > 0) {
      pods = this.lastPods;
    }

    console.log(`📦 Dashboard: ${pods.length} pods to display`, pods);

    if (!pods || pods.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📦</div>
          <div class="empty-state-title">No Pods Available</div>
          <p>Connect metrics to view pods from your cluster. Click "Connect Metrics" to fetch real-time data.</p>
        </div>
      `;
      this.updatePodsStats([]);
      return;
    }

    // Store pods for reference
    this.lastPods = pods;

    // Generate HTML for pods list
    container.innerHTML = pods.map(pod => {
      const name = pod.name || pod.podName || 'Unknown';
      const namespace = pod.namespace || 'default';
      const status = (pod.status || pod.phase || 'Unknown').toLowerCase();
      const app = pod.labels?.app || '';

      // Determine status badge class
      let statusClass = 'unknown';
      let statusIcon = '❓';
      if (status.includes('running')) {
        statusClass = 'running';
        statusIcon = '✅';
      } else if (status.includes('pending') || status.includes('waiting')) {
        statusClass = 'pending';
        statusIcon = '⏳';
      } else if (status.includes('failed') || status.includes('terminated') || status.includes('crashloop')) {
        statusClass = 'failed';
        statusIcon = '❌';
      }

      // Map status to display text
      const statusText = pod.status || pod.phase || 'Unknown';

      // Restart info
      const restarts = pod.restarts || 0;
      const restartWarning = restarts > 3 ? '🔴' : restarts > 0 ? '⚠️' : '';

      // Check for container issues
      let issueBadge = '';
      if (pod.hasError || pod.exitCode !== 0) {
        issueBadge = `<span style="background: rgba(239,68,68,0.1); color: #ef4444; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin-left: 8px;">Exit: ${pod.exitCode}</span>`;
      }

      // App icon based on type
      let appIcon = '📦';
      if (app.includes('frontend')) appIcon = '🌐';
      else if (app.includes('api') || app.includes('service')) appIcon = '⚙️';
      else if (app.includes('db') || app.includes('redis') || app.includes('postgres')) appIcon = '💾';
      else if (app.includes('cart')) appIcon = '🛒';
      else if (app.includes('payment')) appIcon = '💳';
      else if (app.includes('email')) appIcon = '📧';
      else if (app.includes('checkout')) appIcon = '🛍️';
      else if (app.includes('recommendation')) appIcon = '⭐';

      return `
        <div class="pod-item" style="border-left: 3px solid ${statusClass === 'running' ? '#10b981' : statusClass === 'failed' ? '#ef4444' : '#f59e0b'};">
          <div class="pod-info">
            <div class="pod-icon">${appIcon}</div>
            <div class="pod-details">
              <div class="pod-name">${name} ${issueBadge}</div>
              <div class="pod-namespace">
                <span style="background: rgba(59,130,246,0.1); color: #3b82f6; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin-right: 8px;">${namespace}</span>
                <span style="color: var(--text-secondary);">Restarts: ${restarts} ${restartWarning}</span>
                ${pod.age ? `<span style="color: var(--text-muted); margin-left: 8px;">Age: ${pod.age}</span>` : ''}
              </div>
            </div>
          </div>
          <div class="pod-status-badge ${statusClass}">
            <span class="pod-status-dot"></span>
            <span>${statusIcon} ${statusText}</span>
          </div>
        </div>
      `;
    }).join('');

    // Update pod statistics
    this.updatePodsStats(pods);
  }

  /**
   * Update pod statistics
   */
  updatePodsStats(pods) {
    const totalEl = document.getElementById('podsTotal');
    const runningEl = document.getElementById('podsRunning');
    const pendingEl = document.getElementById('podsPending');
    const failedEl = document.getElementById('podsFailed');

    if (totalEl) totalEl.textContent = pods.length;

    const running = pods.filter(p => {
      const status = (p.status || p.phase || '').toLowerCase();
      return status.includes('running');
    }).length;

    const pending = pods.filter(p => {
      const status = (p.status || p.phase || '').toLowerCase();
      return status.includes('pending') || status.includes('waiting');
    }).length;

    const failed = pods.filter(p => {
      const status = (p.status || p.phase || '').toLowerCase();
      return status.includes('failed') || status.includes('terminated') || status.includes('error');
    }).length;

    // Count pods with restart issues
    const restartIssues = pods.filter(p => (p.restarts || 0) > 3).length;

    if (runningEl) runningEl.textContent = running;
    if (pendingEl) pendingEl.textContent = pending;
    if (failedEl) failedEl.textContent = failed;

    // Update issues count based on restart issues
    if (restartIssues > 0 && this.currentState.issues.length === 0) {
      // Add synthetic issue for pods with high restarts
      const newIssues = pods
        .filter(p => (p.restarts || 0) > 3)
        .map(p => ({
          target: p.name,
          problem: `Pod has ${p.restarts} restarts (last exit: ${p.exitCode || 'unknown'})`,
          severity: p.restarts > 10 ? 'high' : 'medium',
          type: 'stability'
        }));
      if (newIssues.length > 0) {
        this.currentState.issues = newIssues;
        this.updateIssuesList();
      }
    }
  }

  /**
   * Update all agent cards
   */
  updateAllAgents() {
    Object.keys(this.currentState.agents).forEach(agent => {
      this.updateAgentCard(agent, this.currentState.agents[agent]);
    });
  }

  /**
   * Update agent status
   */
  updateAgentStatus(agent, status) {
    if (this.currentState.agents[agent]) {
      this.currentState.agents[agent] = {
        ...this.currentState.agents[agent],
        ...status,
        lastRun: new Date().toISOString()
      };
      this.updateAgentCard(agent, this.currentState.agents[agent]);
    }
  }

  /**
   * Update agent card UI
   */
  updateAgentCard(agent, status) {
    const card = document.getElementById(`agent-${agent}`);
    if (!card) return;

    const statusEl = card.querySelector('.agent-status-badge');
    const progressEl = card.querySelector('.progress-fill');
    const lastRunEl = card.querySelector('.agent-last-run');

    // Update card state
    card.className = 'agent-card';
    if (status.status && status.status !== 'idle') {
      card.classList.add(status.status);
    }

    // Update status badge
    if (statusEl) {
      const statusMap = {
        idle: { text: 'Idle', class: 'idle' },
        running: { text: 'Running', class: 'running' },
        analyzing: { text: 'Analyzing', class: 'analyzing' },
        success: { text: 'Success', class: 'success' },
        error: { text: 'Error', class: 'error' },
        'issues-found': { text: 'Issues Found', class: 'issues-found' },
        'issues-confirmed': { text: 'Issues Confirmed', class: 'issues-found' }
      };

      const mapped = statusMap[status.status] || { text: status.status, class: 'idle' };
      statusEl.className = `agent-status-badge ${mapped.class}`;
      statusEl.textContent = mapped.text;
    }

    // Update progress bar
    if (progressEl) {
      let progress = 0;
      switch (status.status) {
        case 'running':
        case 'analyzing':
          progress = 50;
          break;
        case 'success':
        case 'issues-found':
        case 'issues-confirmed':
          progress = 100;
          break;
      }
      progressEl.style.width = `${progress}%`;
    }

    // Update last run
    if (lastRunEl && status.lastRun) {
      const date = new Date(status.lastRun);
      const timeStr = date.toLocaleTimeString();
      lastRunEl.textContent = `Last run: ${timeStr}`;
    }
  }

  /**
   * Add timeline event
   */
  addTimelineEvent(event) {
    this.currentState.timeline.unshift(event);
    if (this.currentState.timeline.length > 100) {
      this.currentState.timeline.pop();
    }
    this.updateTimeline();
  }

  /**
   * Update timeline display
   */
  updateTimeline() {
    const container = document.getElementById('timeline');
    if (!container) return;

    const events = this.currentState.timeline;

    if (events.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📋</div>
          <div class="empty-state-title">No Events Yet</div>
          <p>Run the self-healing system to start recording events.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = events.map(event => {
      const time = event.time || new Date(event.timestamp).toLocaleTimeString();
      const type = event.type || 'info';
      const description = event.description || event.message;

      return `
        <div class="timeline-item">
          <div class="timeline-time">${time}</div>
          <div class="timeline-marker ${type}"></div>
          <div class="timeline-content">
            <div class="timeline-type ${type}">${type}</div>
            <div class="timeline-message">${description}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  /**
   * Update RCA display
   */
  updateRCADisplay(rcaData) {
    console.log('🌳 RCA Data received:', rcaData);
    this.currentState.rca = rcaData;

    // Update root cause card
    const rootCauseEl = document.getElementById('rcaRootCause');
    const rootCauseNameEl = document.getElementById('rcaRootCauseName');
    const confidenceValueEl = document.getElementById('rcaConfidenceValue');
    const confidenceEl = document.getElementById('rcaConfidence');

    if (rcaData && rcaData.rootCause) {
      if (rootCauseEl) rootCauseEl.style.display = 'block';
      if (rootCauseNameEl) rootCauseNameEl.textContent = rcaData.rootCause;
      if (confidenceValueEl) confidenceValueEl.textContent = `${rcaData.confidence}%`;
      if (confidenceEl) confidenceEl.textContent = `Confidence: ${rcaData.confidence}%`;

      // Update flow visualization
      this.updateDependencyFlow(rcaData);

      // Update SVG graph with RCA chain data
      this.updateDependencyGraph(rcaData);
    } else {
      if (rootCauseEl) rootCauseEl.style.display = 'none';
    }
  }

  /**
   * Update dependency flow visualization
   */
  updateDependencyFlow(rcaData) {
    const container = document.getElementById('dependencyFlow');
    if (!container) return;

    const chain = rcaData.chainDetails || [];
    if (chain.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🌳</div>
          <div class="empty-state-title">No Dependency Chain</div>
          <p>No cascading dependencies detected.</p>
        </div>
      `;
      return;
    }

    // Sort by depth
    const sorted = [...chain].sort((a, b) => a.depth - b.depth);
    const rootName = rcaData.rootCause;

    container.innerHTML = sorted.map((step, index) => {
      const isRoot = step.name === rootName;
      const isHealthy = step.health?.healthy;
      const stepClass = isRoot ? 'root' : (isHealthy ? 'healthy' : 'cascade');
      const icon = isRoot ? '💥' : (isHealthy ? '✅' : '⚡');
      const label = isRoot ? 'ROOT CAUSE' : (isHealthy ? 'HEALTHY' : 'AFFECTED');

      const html = `
        <div class="flow-step ${stepClass}">
          <div class="flow-step-icon">${icon}</div>
          <div class="flow-step-content">
            <div class="flow-step-name">${step.name}</div>
            <div class="flow-step-status">${step.health?.reason || 'Unknown status'}</div>
          </div>
          <div class="flow-step-badge">${label}</div>
        </div>
      `;

      if (index < sorted.length - 1) {
        return html + `
          <div class="flow-connector">
            <div class="flow-connector-arrow">▼</div>
          </div>
        `;
      }
      return html;
    }).join('');
  }

  /**
   * Update SVG dependency graph with RCA chain data
   */
  updateDependencyGraph(rcaData) {
    const svg = document.getElementById('dependencySvg');
    const nodesGroup = document.getElementById('graphNodes');
    const edgesGroup = document.getElementById('graphEdges');

    if (!svg || !nodesGroup || !edgesGroup) {
      console.warn('SVG elements not found for dependency graph');
      return;
    }

    // Clear existing graph
    nodesGroup.innerHTML = '';
    edgesGroup.innerHTML = '';

    // Get chain details from RCA data
    const chain = rcaData?.chainDetails || [];

    if (chain.length === 0) {
      console.log('No chain details to render in graph');
      return;
    }

    console.log(`🎨 Rendering dependency graph with ${chain.length} nodes`);

    const rootName = rcaData.rootCause;

    // Calculate positions - tree layout
    const svgWidth = 800;
    const centerX = svgWidth / 2;
    const startY = 80;
    const levelHeight = 100;

    // Group nodes by depth to handle multiple nodes at same level
    const nodesByDepth = {};
    chain.forEach(step => {
      if (!nodesByDepth[step.depth]) nodesByDepth[step.depth] = [];
      nodesByDepth[step.depth].push(step);
    });

    // Calculate positions for each node
    const nodePositions = new Map();
    let globalIndex = 0;

    Object.keys(nodesByDepth).sort((a, b) => parseInt(a) - parseInt(b)).forEach(depth => {
      const nodesAtDepth = nodesByDepth[depth];
      const siblingCount = nodesAtDepth.length;

      nodesAtDepth.forEach((step, idx) => {
        const isRoot = step.name === rootName;
        const isHealthy = step.health?.healthy;

        // Calculate horizontal position
        const siblingIndex = idx;
        const offset = siblingCount > 1 ? (siblingIndex - (siblingCount - 1) / 2) * 200 : 0;

        const x = centerX + offset;
        const y = startY + parseInt(depth) * levelHeight;

        nodePositions.set(step.name, {
          ...step,
          x,
          y,
          isRoot,
          isHealthy,
          globalIndex: globalIndex++
        });
      });
    });

    const nodes = Array.from(nodePositions.values());

    // Draw edges first (so they appear behind nodes)
    nodes.forEach(node => {
      // Find parent nodes (dependencies)
      const parentDeps = node.dependencies || [];
      parentDeps.forEach(dep => {
        const parentName = dep.resolvedTo || dep.target;
        const parent = nodePositions.get(parentName);

        if (parent) {
          const isRootEdge = parent.isRoot || node.isRoot;

          // Create curved path
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          const startX = parent.x;
          const startY = parent.y + 30;
          const endX = node.x;
          const endY = node.y - 30;
          const midY = (startY + endY) / 2;

          const d = `M${startX},${startY} C${startX},${midY} ${endX},${midY} ${endX},${endY}`;

          path.setAttribute('d', d);
          path.setAttribute('stroke', isRootEdge ? '#ef4444' : '#f59e0b');
          path.setAttribute('stroke-width', isRootEdge ? '3' : '2');
          path.setAttribute('fill', 'none');
          path.setAttribute('marker-end', isRootEdge ? 'url(#arrow-red)' : 'url(#arrow-yellow)');
          edgesGroup.appendChild(path);
        }
      });
    });

    // Draw nodes
    nodes.forEach(node => {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'graph-node');

      // Circle
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', node.x);
      circle.setAttribute('cy', node.y);
      circle.setAttribute('r', node.isRoot ? 35 : 28);

      if (node.isRoot) {
        circle.setAttribute('fill', '#fee2e2');
        circle.setAttribute('stroke', '#ef4444');
        circle.setAttribute('stroke-width', '4');
      } else if (node.isHealthy) {
        circle.setAttribute('fill', '#d1fae5');
        circle.setAttribute('stroke', '#10b981');
        circle.setAttribute('stroke-width', '2');
      } else {
        circle.setAttribute('fill', '#fef3c7');
        circle.setAttribute('stroke', '#f59e0b');
        circle.setAttribute('stroke-width', '2');
      }

      // Label - pod name
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', node.x);
      text.setAttribute('y', node.y + 50);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', '#1e293b');
      text.setAttribute('font-size', '11');
      text.setAttribute('font-weight', '600');

      // Truncate long names
      const displayName = node.name.length > 20 ? node.name.substring(0, 17) + '...' : node.name;
      text.textContent = displayName;

      // Status text
      const statusText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      statusText.setAttribute('x', node.x);
      statusText.setAttribute('y', node.y + 65);
      statusText.setAttribute('text-anchor', 'middle');
      statusText.setAttribute('fill', '#64748b');
      statusText.setAttribute('font-size', '9');
      const status = node.health?.reason || 'Unknown';
      statusText.textContent = status.length > 35 ? status.substring(0, 32) + '...' : status;

      // Add tooltip title
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${node.name}\nStatus: ${node.health?.reason || 'Unknown'}\nType: ${node.type || 'pod'}`;

      g.appendChild(circle);
      g.appendChild(text);
      g.appendChild(statusText);
      g.appendChild(title);
      nodesGroup.appendChild(g);
    });

    console.log(`✅ Dependency graph rendered with ${nodes.length} nodes`);
  }

  /**
   * Setup configuration panel
   */
  setupConfigPanel() {
    const updateBtn = document.getElementById('updateConfigBtn');
    const input = document.getElementById('metricsUrl');
    const status = document.getElementById('configStatus');

    if (updateBtn && input) {
      updateBtn.addEventListener('click', async () => {
        const url = input.value.trim();
        if (!url) {
          if (status) {
            status.textContent = '❌ Please enter a valid URL';
            status.style.color = '#ef4444';
          }
          return;
        }

        // Validate URL format
        try {
          new URL(url);
        } catch {
          if (status) {
            status.textContent = '❌ Invalid URL format';
            status.style.color = '#ef4444';
          }
          return;
        }

        // Show connecting status
        if (status) {
          status.textContent = '🔄 Connecting to metrics endpoint...';
          status.style.color = '#3b82f6';
        }
        updateBtn.disabled = true;
        updateBtn.textContent = '⏳ Connecting...';

        // Save to localStorage
        localStorage.setItem('metricsUrl', url);
        this.currentState.metricsUrl = url;

        // Send to server
        try {
          const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ metricsUrl: url })
          });

          if (response.ok) {
            if (status) {
              status.innerHTML = '✅ <strong>Real-time metrics CONNECTED!</strong><br/>🔄 <strong>Live refresh:</strong> Every 5 seconds | Analysis running continuously';
              status.style.color = '#10b981';
            }
            updateBtn.textContent = '🔗 Metrics LIVE';
            updateBtn.disabled = false;
            
            // Auto-trigger healing immediately and every 10 seconds
            console.log('📊 Starting continuous real-time analysis...');
            if (document.getElementById('runHealingBtn')) {
              document.getElementById('runHealingBtn').click();
            }
            // Continue analysis every 10 seconds
            this.continuousAnalysisInterval = setInterval(() => {
              if (!this.isRunning && document.getElementById('runHealingBtn')) {
                console.log('🔄 [AUTO] Continuous analysis cycle...');
                document.getElementById('runHealingBtn').click();
              }
            }, 10000);
          } else {
            throw new Error('Server rejected configuration');
          }
        } catch (err) {
          if (status) {
            status.textContent = '⚠️ Connection failed: ' + err.message;
            status.style.color = '#f59e0b';
          }
          updateBtn.disabled = false;
          updateBtn.textContent = '📡 Retry Connection';
        }
      });

      // Allow Enter key to submit
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          updateBtn.click();
        }
      });
    }

    // Setup Dependencies page "Connect" button
    const depConnectBtn = document.getElementById('depConnectBtn');
    const depMetricsUrl = document.getElementById('depMetricsUrl');
    const depStatus = document.getElementById('depConnectionStatus');

    if (depConnectBtn && depMetricsUrl) {
      depConnectBtn.addEventListener('click', async () => {
        const url = depMetricsUrl.value.trim();
        if (!url) {
          this.showDepStatus('❌ Please enter a metrics URL', 'error');
          return;
        }

        try {
          new URL(url);
        } catch {
          this.showDepStatus('❌ Invalid URL format', 'error');
          return;
        }

        depConnectBtn.disabled = true;
        depConnectBtn.textContent = '⏳ Connecting...';
        this.showDepStatus('🔄 Connecting to metrics endpoint...', 'info');

        try {
          const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ metricsUrl: url })
          });

          if (response.ok) {
            this.currentState.metricsUrl = url;
            localStorage.setItem('metricsUrl', url);
            this.showDepStatus('✅ Connected! Metrics loading...', 'success');
            depConnectBtn.textContent = '🔗 Connected';

            // Trigger healing to load data
            setTimeout(() => {
              if (document.getElementById('runHealingBtn')) {
                document.getElementById('runHealingBtn').click();
              }
            }, 500);
          } else {
            throw new Error('Server rejected configuration');
          }
        } catch (err) {
          this.showDepStatus(`⚠️ Connection failed: ${err.message}`, 'error');
          depConnectBtn.disabled = false;
          depConnectBtn.textContent = '📡 Retry';
        }
      });

      // Allow Enter key to submit
      depMetricsUrl.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          depConnectBtn.click();
        }
      });
    }
  }

  /**
   * Show status message on Dependencies page
   */
  showDepStatus(message, type) {
    const statusEl = document.getElementById('depConnectionStatus');
    if (!statusEl) return;

    statusEl.style.display = 'block';
    statusEl.textContent = message;

    if (type === 'error') {
      statusEl.style.background = '#fef2f2';
      statusEl.style.color = '#dc2626';
      statusEl.style.border = '1px solid #fecaca';
    } else if (type === 'success') {
      statusEl.style.background = '#f0fdf4';
      statusEl.style.color = '#15803d';
      statusEl.style.border = '1px solid #bbf7d0';
    } else {
      statusEl.style.background = '#eff6ff';
      statusEl.style.color = '#1d4ed8';
      statusEl.style.border = '1px solid #bfdbfe';
    }
  }

  /**
   * Setup navigation
   */
  setupNavigation() {
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const page = link.dataset.page;
        this.navigateToPage(page);

        // Update active state
        document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
        link.classList.add('active');
      });
    });
  }

  /**
   * Navigate to page
   */
  navigateToPage(pageId) {
    this.currentPage = pageId;
    document.querySelectorAll('.page').forEach(page => {
      page.classList.remove('active');
    });

    const targetPage = document.getElementById(`page-${pageId}`);
    if (targetPage) {
      targetPage.classList.add('active');
      // Refresh data for the page if needed
      if (pageId === 'alerts') {
        this.updateAlertsList();
      } else if (pageId === 'dependency-graph') {
        this.drawDependencyGraph();
      }
    }
  }

  /**
   * Setup keyboard shortcuts
   */
  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) {
        switch (e.key) {
          case '1':
            e.preventDefault();
            this.navigateToPage('dashboard');
            break;
          case '2':
            e.preventDefault();
            this.navigateToPage('dependency-graph');
            break;
          case 'r':
            e.preventDefault();
            triggerHealing();
            break;
        }
      }
    });
  }

  /**
   * Update alerts list
   */
  updateAlertsList() {
    const container = document.getElementById('alertsList');
    if (!container) return;

    const alerts = this.currentState.alerts || [];
    const failureAnalysis = this.currentState.failureAnalysis;

    // Update alert stats
    const criticalCount = alerts.filter(a => a.severity === 'critical').length;
    const warningCount = alerts.filter(a => a.severity === 'warning').length;
    const impactScore = failureAnalysis?.impactScore || 0;
    const affectedCount = failureAnalysis?.cascadingAffected?.length || 0;

    // Update stat cards
    const criticalEl = document.getElementById('alertsCritical');
    const warningEl = document.getElementById('alertsWarning');
    const impactEl = document.getElementById('impactScore');
    const affectedEl = document.getElementById('affectedPodsCount');

    if (criticalEl) criticalEl.textContent = criticalCount;
    if (warningEl) warningEl.textContent = warningCount;
    if (impactEl) impactEl.textContent = impactScore;
    if (affectedEl) affectedEl.textContent = affectedCount;

    if (alerts.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">✅</div>
          <div class="empty-state-title">No Active Alerts</div>
          <p>Your system is healthy. All pods are running normally.</p>
        </div>
      `;
      return;
    }

    // Render alerts
    container.innerHTML = alerts.map(alert => {
      const impactPercent = Math.min(100, (alert.impactScore || 0));
      const recommendations = alert.recommendations || [];

      return `
        <div class="alert ${alert.severity}">
          <div class="alert-header">
            <div class="alert-title">
              ${alert.severity === 'critical' ? '🔴' : '⚠️'} ${alert.pod}
            </div>
            <div style="display: flex; gap: 12px; align-items: center;">
              <span class="alert-severity">${alert.severity}</span>
              <button class="alert-close" onclick="window.dashboardApp.dismissAlert('${alert.id}')">×</button>
            </div>
          </div>
          <div class="alert-message">${alert.message}</div>
          
          <div class="impact-meter">
            <span style="font-size: 12px; color: var(--text-secondary); min-width: 80px;">Impact Score:</span>
            <div class="impact-bar">
              <div class="impact-fill" style="width: ${impactPercent}%;">
                ${impactPercent}%
              </div>
            </div>
          </div>

          <div class="alert-details">
            <div class="alert-detail">
              <div class="alert-detail-label">Criticality</div>
              <div class="alert-detail-value">${alert.criticality}</div>
            </div>
            <div class="alert-detail">
              <div class="alert-detail-label">Timestamp</div>
              <div class="alert-detail-value">${new Date(alert.timestamp).toLocaleTimeString()}</div>
            </div>
            <div class="alert-detail">
              <div class="alert-detail-label">Dependent Services</div>
              <div class="alert-detail-value">${alert.dependents?.length || 0} pods</div>
            </div>
          </div>

          ${recommendations.length > 0 ? `
            <div class="alert-recommendations">
              <div class="alert-rec-title">Recommended Actions</div>
              <ul class="alert-rec-list">
                ${recommendations.map(rec => `<li class="alert-rec-item">${rec}</li>`).join('')}
              </ul>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  }

  /**
   * Handle individual alert
   */
  handleAlert(data) {
    console.log('🚨 Alert received:', data);
    // Update alerts list if on alerts page
    if (this.currentPage === 'alerts') {
      this.updateAlertsList();
    }
    // Play notification sound (optional)
    if (data.severity === 'critical') {
      console.warn('⚠️  CRITICAL ALERT:', data.pod);
    }
  }

  /**
   * Dismiss alert
   */
  dismissAlert(alertId) {
    // Call backend to dismiss
    fetch(`/api/alerts/${alertId}`, { method: 'DELETE' })
      .then(() => this.updateAlertsList())
      .catch(err => console.error('Error dismissing alert:', err));
  }

  /**
   * Draw dependency graph - Professional compact layout
   * Color scheme: Root Cause = Red, Affected = Yellow, Healthy = Green
   */
  drawDependencyGraph() {
    const graphData = this.currentState.dependencyGraph;
    const container = document.getElementById('dependencyGraphContainer');
    const svg = document.getElementById('dependencyGraphSvg');
    const emptyState = document.getElementById('graphEmptyState');

    if (!container || !svg) return;

    const totalNodesEl = document.getElementById('depGraphTotalNodes');
    const totalLinksEl = document.getElementById('depGraphTotalLinks');
    const criticalPathEl = document.getElementById('depGraphCriticalPath');
    const rootCauseEl = document.getElementById('depGraphRootCause');

    if (!graphData || !graphData.nodes || graphData.nodes.length === 0) {
      if (emptyState) emptyState.style.display = 'flex';
      if (totalNodesEl) totalNodesEl.textContent = '0';
      if (totalLinksEl) totalLinksEl.textContent = '0';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';

    const nodes = graphData.nodes || [];
    const links = graphData.links || [];

    // Update stats
    if (totalNodesEl) totalNodesEl.textContent = nodes.length;
    if (totalLinksEl) totalLinksEl.textContent = links.length;

    // Get failed pods and root cause
    const failedPods = this.currentState.raw?.pods
      ?.filter(p => {
        const status = String(p.status).toLowerCase();
        return status.includes('fail') || status.includes('error') || status.includes('crash');
      })
      .map(p => p.name) || [];

    const rootCause = this.currentState.rca?.rootCause;
    const cascadingPods = this.currentState.failureAnalysis?.cascadingAffected || [];

    // Update critical path and root cause
    if (criticalPathEl) {
      const criticalNodes = nodes.filter(n => n.criticality === 'critical').length;
      criticalPathEl.textContent = criticalNodes > 0 ? `${criticalNodes} services` : '-';
    }
    if (rootCauseEl) {
      rootCauseEl.textContent = rootCause ? rootCause.split(' ')[0] : '-';
    }

    // Get container dimensions - use actual size with padding
    const containerRect = container.getBoundingClientRect();
    const width = Math.max(containerRect.width - 40, 800);
    const height = 500;
    const padding = 60;

    // Color scheme: Root Cause = RED, Affected = YELLOW, Healthy = GREEN
    const getNodeColor = (node) => {
      const isFailed = failedPods.includes(node.id);
      const isCascading = cascadingPods.includes(node.id);
      const isRootCause = node.id === rootCause;

      if (isRootCause) return { fill: '#fef2f2', stroke: '#dc2626', text: '#991b1b' }; // Red
      if (isFailed) return { fill: '#fef2f2', stroke: '#ef4444', text: '#b91c1c' }; // Red
      if (isCascading) return { fill: '#fefce8', stroke: '#eab308', text: '#854d0e' }; // Yellow
      return { fill: '#f0fdf4', stroke: '#22c55e', text: '#15803d' }; // Green
    };

    // Build dependency tree structure
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const childrenMap = {};
    const parentCount = {};

    links.forEach(link => {
      if (!childrenMap[link.target]) childrenMap[link.target] = [];
      if (!childrenMap[link.source]) childrenMap[link.source] = [];
      childrenMap[link.target].push(link.source);
      parentCount[link.source] = (parentCount[link.source] || 0) + 1;
    });

    // Find root nodes (no dependencies)
    const roots = nodes.filter(n => !parentCount[n.id]).map(n => n.id);

    // Calculate levels using BFS
    const levels = {};
    const visited = new Set();
    const queue = [...roots];
    roots.forEach(r => { levels[r] = 0; visited.add(r); });

    while (queue.length > 0) {
      const nodeId = queue.shift();
      const children = childrenMap[nodeId] || [];
      children.forEach(childId => {
        if (!visited.has(childId) && nodeMap.has(childId)) {
          levels[childId] = levels[nodeId] + 1;
          visited.add(childId);
          queue.push(childId);
        }
      });
    }

    // Group nodes by level
    const nodesByLevel = {};
    Object.entries(levels).forEach(([nodeId, level]) => {
      if (!nodesByLevel[level]) nodesByLevel[level] = [];
      nodesByLevel[level].push(nodeId);
    });

    // Calculate compact positions
    const positions = {};
    const maxLevel = Math.max(...Object.values(levels), 0);
    const levelHeight = (height - padding * 2) / (maxLevel + 1);

    Object.entries(nodesByLevel).forEach(([level, nodeIds]) => {
      const levelNum = parseInt(level);
      const count = nodeIds.length;
      const availableWidth = width - padding * 2;
      const spacing = availableWidth / (count + 1);

      nodeIds.forEach((nodeId, idx) => {
        positions[nodeId] = {
          x: padding + spacing * (idx + 1),
          y: padding + levelNum * levelHeight
        };
      });
    });

    // Clear existing graph
    const edgesGroup = document.getElementById('graphEdges');
    const nodesGroup = document.getElementById('graphNodes');
    if (edgesGroup) edgesGroup.innerHTML = '';
    if (nodesGroup) nodesGroup.innerHTML = '';

    // Draw edges first (behind nodes)
    links.forEach(link => {
      const sourcePos = positions[link.source];
      const targetPos = positions[link.target];

      if (sourcePos && targetPos) {
        const sourceNode = nodeMap.get(link.source);
        const targetNode = nodeMap.get(link.target);
        const sourceColor = getNodeColor(sourceNode);
        const targetColor = getNodeColor(targetNode);

        // Determine edge color based on target node
        let edgeColor = '#22c55e'; // Default green
        if (targetColor.stroke === '#dc2626' || targetColor.stroke === '#ef4444') {
          edgeColor = '#ef4444'; // Red for root cause/failed
        } else if (targetColor.stroke === '#eab308') {
          edgeColor = '#eab308'; // Yellow for affected
        }

        // Create curved path
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const midY = (sourcePos.y + targetPos.y) / 2;

        const d = `M${sourcePos.x},${sourcePos.y} C${sourcePos.x},${midY} ${targetPos.x},${midY} ${targetPos.x},${targetPos.y}`;

        path.setAttribute('d', d);
        path.setAttribute('stroke', edgeColor);
        path.setAttribute('stroke-width', '2');
        path.setAttribute('fill', 'none');
        path.setAttribute('opacity', '0.6');
        edgesGroup.appendChild(path);
      }
    });

    // Draw nodes
    nodes.forEach(node => {
      const pos = positions[node.id];
      if (!pos) return;

      const colors = getNodeColor(node);
      const isRootCause = node.id === rootCause;

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'graph-node');
      g.style.cursor = 'pointer';

      // Outer glow for root cause
      if (isRootCause) {
        const glow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        glow.setAttribute('cx', pos.x);
        glow.setAttribute('cy', pos.y);
        glow.setAttribute('r', 32);
        glow.setAttribute('fill', colors.stroke);
        glow.setAttribute('opacity', '0.2');
        g.appendChild(glow);
      }

      // Main circle
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', pos.x);
      circle.setAttribute('cy', pos.y);
      circle.setAttribute('r', 28);
      circle.setAttribute('fill', colors.fill);
      circle.setAttribute('stroke', colors.stroke);
      circle.setAttribute('stroke-width', isRootCause ? '3' : '2');
      circle.style.transition = 'all 0.2s ease';
      g.appendChild(circle);

      // Inner dot for visual interest
      const innerDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      innerDot.setAttribute('cx', pos.x);
      innerDot.setAttribute('cy', pos.y);
      innerDot.setAttribute('r', 6);
      innerDot.setAttribute('fill', colors.stroke);
      g.appendChild(innerDot);

      // Label - service name (below node)
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', pos.x);
      text.setAttribute('y', pos.y + 45);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', '#374151');
      text.setAttribute('font-size', '11');
      text.setAttribute('font-weight', '600');

      // Truncate long names
      let displayName = node.label || node.id;
      if (displayName.length > 14) {
        displayName = displayName.substring(0, 12) + '..';
      }
      text.textContent = displayName;
      g.appendChild(text);

      // Status badge
      const statusText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      statusText.setAttribute('x', pos.x);
      statusText.setAttribute('y', pos.y + 58);
      statusText.setAttribute('text-anchor', 'middle');
      statusText.setAttribute('fill', colors.text);
      statusText.setAttribute('font-size', '9');
      statusText.setAttribute('font-weight', '500');

      let statusLabel = 'HEALTHY';
      if (isRootCause) statusLabel = 'ROOT CAUSE';
      else if (colors.stroke === '#ef4444') statusLabel = 'FAILED';
      else if (colors.stroke === '#eab308') statusLabel = 'AFFECTED';
      statusText.textContent = statusLabel;
      g.appendChild(statusText);

      // Tooltip
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${node.id}\nStatus: ${statusLabel}\nCriticality: ${node.criticality || 'medium'}`;
      g.appendChild(title);

      // Hover effects
      g.addEventListener('mouseenter', () => {
        circle.setAttribute('r', 32);
        circle.setAttribute('stroke-width', isRootCause ? '4' : '3');
      });
      g.addEventListener('mouseleave', () => {
        circle.setAttribute('r', 28);
        circle.setAttribute('stroke-width', isRootCause ? '3' : '2');
      });

      nodesGroup.appendChild(g);
    });

    console.log(`✅ Dependency graph rendered: ${nodes.length} nodes, ${links.length} edges`);
  }
}

// Global function to trigger healing
async function triggerHealing() {
  const btn = document.getElementById('runHealingBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '🔄 Running...';
  }

  try {
    const response = await fetch('/api/trigger', { method: 'POST' });
    if (response.ok) {
      console.log('Self-healing triggered');
    } else {
      console.error('Failed to trigger healing');
    }
  } catch (err) {
    console.error('Error triggering healing:', err);
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '🚀 Run Self-Healing';
      }
    }, 2000);
  }
}

// Global function to clear timeline
function clearTimeline() {
  const container = document.getElementById('timeline');
  if (container) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <div class="empty-state-title">No Events Yet</div>
        <p>Run the self-healing system to start recording events.</p>
      </div>
    `;
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.dashboardApp = new DashboardApp();
});
