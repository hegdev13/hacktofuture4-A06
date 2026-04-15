/**
 * Main Orchestrator
 * Self-Healing System with validation loop
 * Analyze → Detect → RCA → Fix → Re-check (max 3 retries)
 */

const config = require('./config');
const logger = require('./utils/logger');
const metricsFetcher = require('./utils/metricsFetcher');
const adapter = require('./adapters/clusterStateAdapter');
const observer = require('./agents/observer');
const detector = require('./agents/detector');
const rca = require('./agents/rca');
const executor = require('./agents/executor');
const memory = require('./agents/memory');

class SelfHealingSystem {
  constructor() {
    this.maxRetries = config.system.maxRetries;
    this.retryDelayMs = config.system.retryDelayMs;
    this.healthCheckIntervalMs = config.system.healthCheckIntervalMs;
    this.isRunning = false;
    this.iteration = 0;
    this.agentCallbacks = {};
    this.metricsUrl = process.env.METRICS_URL || '';
  }

  /**
   * Register callback for agent status updates
   */
  onAgentStatus(callback) {
    this.agentCallbacks.status = callback;
  }

  /**
   * Register callback for metrics updates
   */
  onMetricsUpdate(callback) {
    this.agentCallbacks.metrics = callback;
  }

  /**
   * Update metrics and notify callback
   */
  setMetricsData(data) {
    this.lastMetricsData = data;
    if (this.agentCallbacks.metrics) {
      this.agentCallbacks.metrics(data);
    }
  }

  /**
   * Update agent status and notify callback
   */
  setAgentStatus(agent, status, data = {}) {
    if (this.agentCallbacks.status) {
      this.agentCallbacks.status(agent, status, data);
    }
  }

  /**
   * Set the metrics URL for fetching real data
   */
  setMetricsUrl(url) {
    this.metricsUrl = url;
    metricsFetcher.setMetricsUrl(url);
    logger.info(`Metrics URL configured: ${url}`);
  }

  /**
   * Main entry point
   */
  async runSelfHealingSystem(options = {}) {
    logger.banner();
    logger.info('Initializing self-healing system...');
    logger.info(`Mode: ${this.metricsUrl ? 'REAL-TIME' : 'MOCK/DEMO'}`);
    logger.info(`Configuration: maxRetries=${this.maxRetries}, dryRun=${config.execution.dryRun}`);

    this.isRunning = true;

    try {
      // Get initial cluster state
      const clusterState = await this.getClusterState();

      // Run validation loop
      const result = await this.runValidationLoop(clusterState, options);

      // Final status
      this.printFinalStatus(result);

      return result;

    } catch (error) {
      logger.error('Self-healing system failed', error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Validation loop: Analyze → Detect → RCA → Fix → Re-check
   */
  async runValidationLoop(initialState, options = {}) {
    let currentState = initialState;
    let attempts = 0;
    let finalResult = null;

    logger.info('Starting validation loop...');

    while (attempts < this.maxRetries) {
      attempts++;
      this.iteration++;

      logger.info(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      logger.info(`Iteration ${attempts}/${this.maxRetries}`);
      logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

      // Step 1: Observer - Analyze
      this.setAgentStatus('observer', 'running', { step: 'analyzing' });
      const analysis = observer.analyzeClusterState(currentState);
      this.setAgentStatus('observer', analysis.healthy ? 'success' : 'issues-found', {
        step: 'complete',
        issuesFound: analysis.issues?.length || 0,
      });

      if (options.onAnalysis) {
        options.onAnalysis(analysis);
      }

      if (analysis.healthy) {
        logger.timelineEvent('success', 'System is healthy');
        finalResult = {
          success: true,
          attempts: attempts - 1,
          finalHealth: 'healthy',
          issuesFound: 0,
          fixesApplied: 0,
          timeline: logger.getTimeline(),
        };
        break;
      }

      // Check if we should continue
      if (attempts >= this.maxRetries) {
        logger.warn('Max retries reached, exiting validation loop');
        finalResult = {
          success: false,
          attempts,
          finalHealth: 'unhealthy',
          issuesFound: analysis.issues.length,
          fixesApplied: attempts - 1,
          remainingIssues: analysis.issues,
          timeline: logger.getTimeline(),
        };
        break;
      }

      // Step 2: Detector - Confirm and Categorize
      this.setAgentStatus('detector', 'running', { step: 'confirming' });
      const detection = await detector.detectIssues(analysis, currentState);
      this.setAgentStatus('detector', detection.hasIssues ? 'issues-confirmed' : 'success', {
        step: 'complete',
        confirmed: detection.confirmedIssues?.length || 0,
        confidence: detection.confidence,
      });

      if (options.onDetection) {
        options.onDetection(detection);
      }

      // If no issues confirmed, system is healthy
      if (!detection.hasIssues) {
        logger.timelineEvent('success', 'All issues cleared - system healthy');
        finalResult = {
          success: true,
          attempts: attempts,
          finalHealth: 'healthy',
          issuesFound: analysis.issues.length,
          fixesApplied: 0,
          timeline: logger.getTimeline(),
        };
        break;
      }

      // Step 3: RCA - Root Cause Analysis
      this.setAgentStatus('rca', 'running', { step: 'analyzing' });
      const detectedIssues = detection.confirmedIssues.map(issue => ({
        target: issue.target || issue.pod || issue.node,
        problem: issue.problem,
        severity: issue.severity,
        metric: issue.metric,
        details: issue.details,
        detectionId: issue.detectionId,
        isFlapping: issue.isFlapping,
      }));

      // Ensure currentState has proper structure for RCA
      const stateForRCA = {
        pods: currentState.pods || [],
        services: currentState.services || [],
        nodes: currentState.nodes || [],
        timestamp: currentState.timestamp || new Date().toISOString(),
      };

      const rcaOutput = rca.performRCA(stateForRCA, detectedIssues);
      this.setAgentStatus('rca', 'success', {
        step: 'complete',
        rootCause: rcaOutput.rootCause,
        confidence: rcaOutput.confidence,
      });

      // Emit RCA result for dashboard integration
      if (options.onRCA) {
        options.onRCA(rcaOutput);
      }

      // Also broadcast RCA data via metrics callback for real-time updates
      this.setMetricsData({
        rca: rcaOutput,
        rootCause: rcaOutput.rootCause,
        confidence: rcaOutput.confidence,
        chainDetails: rcaOutput.chainDetails,
        timestamp: new Date().toISOString(),
      });

      // Step 4: Executor - Execute Fix
      this.setAgentStatus('executor', 'running', { step: 'executing' });
      const fixResult = await executor.executeFix(rcaOutput, currentState);
      this.setAgentStatus('executor', fixResult.status, {
        step: 'complete',
        fixType: fixResult.fixType,
        target: fixResult.target,
        status: fixResult.status,
      });

      logger.info(`\nFix execution: ${fixResult.fixType} on ${fixResult.target}`);
      logger.info(`Status: ${fixResult.status}`);
      if (fixResult.message) {
        logger.info(`Message: ${fixResult.message}`);
      }

      if (fixResult.status !== 'success') {
        logger.warn(`Fix failed: ${fixResult.error || fixResult.message}`);

        // Check if we should retry
        if (attempts < this.maxRetries) {
          logger.info(`Waiting ${this.retryDelayMs}ms before retry...`);
          await this.sleep(this.retryDelayMs);
        }
      }

      // Step 5: Re-check (get fresh state)
      logger.timelineEvent('analysis', 'Re-checking system health...');
      currentState = await this.getClusterState();

      // Wait before next iteration
      if (attempts < this.maxRetries && !analysis.healthy) {
        await this.sleep(2000);
      }
    }

    return finalResult || {
      success: false,
      attempts,
      error: 'Loop exited without result',
      timeline: logger.getTimeline(),
    };
  }

  /**
   * Get cluster state - uses real metrics if URL is configured
   */
  async getClusterState() {
    if (this.metricsUrl) {
      try {
        logger.debug('Fetching real-time metrics...');
        const metrics = await metricsFetcher.fetchMetrics();
        
        // Broadcast raw metrics to dashboard
        this.setMetricsData(metrics);
        
        return adapter.normalize(metrics);
      } catch (error) {
        logger.warn('Failed to fetch real metrics:', error.message);
        logger.warn('Falling back to mock data...');
      }
    }

    // Fallback to mock data
    return this.getMockClusterState();
  }

  /**
   * Get mock cluster state for testing
   */
  getMockClusterState() {
    logger.warn('⚠️  No real metrics available, using mock data for testing');
    
    // Generate different scenarios based on iteration
    const scenarios = [
      this.healthyScenario(),
      this.highCPUSenario(),
      this.crashLoopScenario(),
      this.dependencyFailureScenario(),
      this.cascadingFailureScenario(),
    ];

    // Use iteration to cycle through scenarios
    const scenarioIndex = (this.iteration - 1) % scenarios.length;
    return adapter.normalize(scenarios[scenarioIndex]);
  }

  /**
   * Start continuous metrics refresh loop
   */
  startContinuousRefresh(intervalMs = 5000) {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }

    logger.info(`🔄 Starting continuous metrics refresh every ${intervalMs}ms`);
    
    this.refreshInterval = setInterval(() => {
      // Force metrics fetcher to get fresh data
      if (metricsFetcher.forceRefreshData) {
        metricsFetcher.forceRefreshData();
      }
    }, intervalMs);
  }

  /**
   * Stop continuous refresh
   */
  stopContinuousRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  /**
   * Healthy scenario
   */
  healthyScenario() {
    return {
      timestamp: new Date().toISOString(),
      source: 'mock',
      nodes: [
        {
          name: 'node-1',
          status: 'Ready',
          cpu: 45,
          memory: 60,
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      ],
      pods: [
        {
          name: 'api-server-7d9f4b8c5-x2z9a',
          namespace: 'default',
          status: 'Running',
          phase: 'Running',
          cpu: 45,
          memory: 60,
          restarts: 0,
          ready: true,
          labels: { app: 'api-server', tier: 'backend' },
          env: { DB_HOST: 'postgres.default.svc' },
          dependencies: [{ type: 'database', name: 'DB_HOST', target: 'postgres', source: 'env' }],
        },
        {
          name: 'postgres-0',
          namespace: 'default',
          status: 'Running',
          phase: 'Running',
          cpu: 30,
          memory: 50,
          restarts: 0,
          ready: true,
          labels: { app: 'postgres', tier: 'database' },
          env: {},
        },
      ],
      services: [
        {
          name: 'api-server',
          namespace: 'default',
          type: 'ClusterIP',
          endpoints: ['api-server-7d9f4b8c5-x2z9a'],
        },
        {
          name: 'postgres',
          namespace: 'default',
          type: 'ClusterIP',
          endpoints: ['postgres-0'],
        },
      ],
      metrics: {
        cluster: { cpuUsage: 40, memoryUsage: 55 },
      },
      logs: [],
    };
  }

  /**
   * High CPU scenario
   */
  highCPUSenario() {
    return {
      timestamp: new Date().toISOString(),
      source: 'mock',
      nodes: [
        {
          name: 'node-1',
          status: 'Ready',
          cpu: 85,
          memory: 60,
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      ],
      pods: [
        {
          name: 'api-server-7d9f4b8c5-x2z9a',
          namespace: 'default',
          status: 'Running',
          phase: 'Running',
          cpu: 97,
          memory: 60,
          restarts: 0,
          ready: true,
          labels: { app: 'api-server', tier: 'backend' },
          env: { DB_HOST: 'postgres.default.svc' },
          dependencies: [{ type: 'database', name: 'DB_HOST', target: 'postgres', source: 'env' }],
        },
        {
          name: 'postgres-0',
          namespace: 'default',
          status: 'Running',
          phase: 'Running',
          cpu: 30,
          memory: 50,
          restarts: 0,
          ready: true,
          labels: { app: 'postgres', tier: 'database' },
          env: {},
        },
      ],
      services: [
        {
          name: 'api-server',
          namespace: 'default',
          type: 'ClusterIP',
          endpoints: ['api-server-7d9f4b8c5-x2z9a'],
        },
        {
          name: 'postgres',
          namespace: 'default',
          type: 'ClusterIP',
          endpoints: ['postgres-0'],
        },
      ],
      metrics: {
        cluster: { cpuUsage: 85, memoryUsage: 55 },
      },
      logs: [
        { timestamp: new Date().toISOString(), pod: 'api-server-7d9f4b8c5-x2z9a', level: 'warn', message: 'High CPU usage detected' },
      ],
    };
  }

  /**
   * Crash loop scenario
   */
  crashLoopScenario() {
    return {
      timestamp: new Date().toISOString(),
      source: 'mock',
      nodes: [
        {
          name: 'node-1',
          status: 'Ready',
          cpu: 50,
          memory: 60,
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      ],
      pods: [
        {
          name: 'api-server-7d9f4b8c5-x2z9a',
          namespace: 'default',
          status: 'CrashLoopBackOff',
          phase: 'Failed',
          cpu: 0,
          memory: 0,
          restarts: 15,
          ready: false,
          labels: { app: 'api-server', tier: 'backend' },
          env: { DB_HOST: 'postgres.default.svc' },
          dependencies: [],
          logs: [
            'FATAL: Connection refused',
            'ERROR: Database connection failed',
            'INFO: Retrying...',
          ],
        },
      ],
      services: [
        {
          name: 'api-server',
          namespace: 'default',
          type: 'ClusterIP',
          endpoints: [],
        },
      ],
      metrics: {
        cluster: { cpuUsage: 50, memoryUsage: 55 },
      },
      logs: [],
    };
  }

  /**
   * Dependency failure scenario
   */
  dependencyFailureScenario() {
    return {
      timestamp: new Date().toISOString(),
      source: 'mock',
      nodes: [
        {
          name: 'node-1',
          status: 'Ready',
          cpu: 50,
          memory: 60,
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      ],
      pods: [
        {
          name: 'api-server-7d9f4b8c5-x2z9a',
          namespace: 'default',
          status: 'Running',
          phase: 'Running',
          cpu: 30,
          memory: 40,
          restarts: 5,
          ready: false,
          labels: { app: 'api-server', tier: 'backend' },
          env: { DB_HOST: 'postgres.default.svc' },
          dependencies: [{ type: 'database', name: 'DB_HOST', target: 'postgres', source: 'env' }],
          logs: [
            'ERROR: Connection timeout to postgres',
            'WARN: Retry attempt 1',
            'ERROR: Connection timeout to postgres',
          ],
        },
        {
          name: 'postgres-0',
          namespace: 'default',
          status: 'Failed',
          phase: 'Failed',
          cpu: 0,
          memory: 0,
          restarts: 20,
          ready: false,
          labels: { app: 'postgres', tier: 'database' },
          env: {},
        },
      ],
      services: [
        {
          name: 'api-server',
          namespace: 'default',
          type: 'ClusterIP',
          endpoints: [],
        },
        {
          name: 'postgres',
          namespace: 'default',
          type: 'ClusterIP',
          endpoints: [],
        },
      ],
      metrics: {
        cluster: { cpuUsage: 50, memoryUsage: 55 },
      },
      logs: [],
    };
  }

  /**
   * Cascading failure scenario
   */
  cascadingFailureScenario() {
    return {
      timestamp: new Date().toISOString(),
      source: 'mock',
      nodes: [
        {
          name: 'node-1',
          status: 'Ready',
          cpu: 95,
          memory: 90,
          conditions: [{ type: 'MemoryPressure', status: 'True' }],
        },
      ],
      pods: [
        {
          name: 'api-server-1',
          namespace: 'default',
          status: 'Running',
          phase: 'Running',
          cpu: 95,
          memory: 98,
          restarts: 8,
          ready: false,
          labels: { app: 'api-server', tier: 'backend' },
          env: { REDIS_URL: 'redis.default.svc' },
          dependencies: [{ type: 'cache', name: 'REDIS_URL', target: 'redis-0', source: 'env' }],
        },
        {
          name: 'api-server-2',
          namespace: 'default',
          status: 'Running',
          phase: 'Running',
          cpu: 92,
          memory: 95,
          restarts: 6,
          ready: false,
          labels: { app: 'api-server', tier: 'backend' },
          env: { REDIS_URL: 'redis.default.svc' },
          dependencies: [{ type: 'cache', name: 'REDIS_URL', target: 'redis-0', source: 'env' }],
        },
        {
          name: 'worker-1',
          namespace: 'default',
          status: 'Running',
          phase: 'Running',
          cpu: 88,
          memory: 90,
          restarts: 4,
          ready: true,
          labels: { app: 'worker', tier: 'backend' },
          env: {},
          dependencies: [{ type: 'upstream', name: 'API_HOST', target: 'api-server-1', source: 'env' }],
        },
        {
          name: 'redis-0',
          namespace: 'default',
          status: 'Running',
          phase: 'Running',
          cpu: 70,
          memory: 85,
          restarts: 2,
          ready: true,
          labels: { app: 'redis', tier: 'cache' },
          env: {},
          dependencies: [],
        },
      ],
      services: [],
      metrics: {
        cluster: { cpuUsage: 92, memoryUsage: 94 },
      },
      logs: [],
    };
  }

  /**
   * Print final status
   */
  printFinalStatus(result) {
    logger.info('\n');
    logger.info('╔══════════════════════════════════════════════════════════════╗');
    logger.info('║                  FINAL SYSTEM STATUS                          ║');
    logger.info('╠══════════════════════════════════════════════════════════════╣');
    logger.info(`║  Success:        ${result.success ? '✅ YES' : '❌ NO'}`);
    logger.info(`║  Attempts:       ${result.attempts}/${this.maxRetries}`);
    logger.info(`║  Final Health:    ${result.finalHealth || 'unknown'}`);
    logger.info(`║  Issues Found:    ${result.issuesFound || 0}`);
    logger.info(`║  Fixes Applied:   ${result.fixesApplied || 0}`);
    logger.info('╚══════════════════════════════════════════════════════════════╝');

    // Print learning stats
    const stats = memory.getStats();
    logger.info('\n📊 Learning Statistics:');
    logger.info(`   Total Learnings: ${stats.totalLearnings}`);
    logger.info(`   Success Rate:    ${stats.successRate}%`);
  }

  /**
   * Get memory stats
   */
  getMemoryStats() {
    return memory.getStats();
  }

  /**
   * Export learning data
   */
  exportLearnings() {
    return memory.export();
  }

  /**
   * Import learning data
   */
  importLearnings(data) {
    return memory.import(data);
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Create and export singleton instance
const system = new SelfHealingSystem();

// Export for programmatic use
module.exports = system;

// Run if called directly
if (require.main === module) {
  // Check if metrics URL is provided via environment
  if (process.env.METRICS_URL) {
    system.setMetricsUrl(process.env.METRICS_URL);
  }

  system.runSelfHealingSystem()
    .then(result => {
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}
