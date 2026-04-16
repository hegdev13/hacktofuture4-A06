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
    this.strictLive = process.env.STRICT_LIVE === 'true';
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
   * Set dry run mode for execution
   */
  setDryRun(enabled) {
    executor.setDryRun(enabled);
    logger.info(`Dry run mode: ${enabled ? 'ENABLED' : 'DISABLED'}`);
    if (!enabled) {
      logger.warn('⚠️  REAL KUBERNETES OPERATIONS ENABLED - This will make actual changes to your cluster');
    }
  }

  /**
   * Get current execution mode info
   */
  getExecutionMode() {
    return executor.getExecutionMode();
  }

  /**
   * Main entry point
   */
  async runSelfHealingSystem(options = {}) {
    logger.banner();
    logger.info('Initializing self-healing system...');
    logger.info(`Mode: ${this.metricsUrl ? 'REAL-TIME' : 'MOCK/DEMO'}`);
    logger.info(`Strict live mode: ${this.strictLive ? 'ENABLED' : 'DISABLED'}`);
    logger.info(`Configuration: maxRetries=${this.maxRetries}, dryRun=${config.execution.dryRun}`);

    if (this.strictLive && !this.metricsUrl) {
      throw new Error('Strict live mode requires METRICS_URL. Provide an ngrok /pods URL.');
    }

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
    const manualTarget = this.getManualTarget(options);
    let detection = null;

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

      if (analysis.healthy && !manualTarget) {
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

      if (manualTarget) {
        if (manualTarget.kind === 'deployment') {
          logger.timelineEvent('fix', `Executing explicit deployment restart for ${manualTarget.namespace}/${manualTarget.name}`);
          this.setAgentStatus('executor', 'running', {
            step: 'executing',
            fixType: 'restart_deployment',
            target: manualTarget.name,
            status: 'running',
          });

          const fixResult = executor.restartDeployment(manualTarget.name, manualTarget.namespace);
          let verification = null;

          if (fixResult.status === 'success' && !this.getExecutionMode().dryRun && executor.verifyFixes !== false) {
            verification = await executor.verifyFix(fixResult.action, currentState);
          }

          this.setAgentStatus('executor', fixResult.status, {
            step: 'complete',
            fixType: fixResult.fixType,
            target: fixResult.target,
            status: fixResult.status,
          });

          if (verification) {
            fixResult.verification = verification;
            if (!verification.verified) {
              fixResult.status = 'partial';
              fixResult.message = `${fixResult.message} (Verification failed: ${verification.reason})`;
            } else {
              fixResult.message = `${fixResult.message} (Verified: ${verification.reason})`;
            }
          }

          const freshState = await this.getClusterState();
          currentState = freshState;

          finalResult = {
            success: fixResult.status === 'success' || fixResult.status === 'simulated',
            attempts,
            finalHealth: fixResult.status === 'success' || fixResult.status === 'simulated' ? 'healthy' : 'unhealthy',
            issuesFound: analysis.issues.length,
            fixesApplied: fixResult.status === 'success' || fixResult.status === 'simulated' ? 1 : 0,
            target: manualTarget,
            verification,
            timeline: logger.getTimeline(),
          };
          break;
        }

        const manualPod = this.resolveManualTargetPod(currentState, manualTarget);
        if (!manualPod) {
          logger.warn(`Selected target not found: ${manualTarget.namespace}/${manualTarget.name}`);
          finalResult = {
            success: false,
            attempts,
            finalHealth: 'unhealthy',
            issuesFound: analysis.issues.length,
            fixesApplied: 0,
            error: `Selected target ${manualTarget.namespace}/${manualTarget.name} was not found in live cluster state`,
            timeline: logger.getTimeline(),
          };
          break;
        }

        const targetedIssue = this.buildManualTargetIssue(manualPod, manualTarget);
        if (!targetedIssue) {
          logger.timelineEvent('success', `Selected target ${manualTarget.namespace}/${manualTarget.name} is already healthy`);
          finalResult = {
            success: true,
            attempts: attempts - 1,
            finalHealth: 'healthy',
            issuesFound: analysis.issues.length,
            fixesApplied: 0,
            target: manualTarget,
            timeline: logger.getTimeline(),
          };
          break;
        }

        logger.timelineEvent('issue', `Prioritizing selected workload ${manualTarget.namespace}/${manualTarget.name}`);
        this.setAgentStatus('detector', 'issues-confirmed', {
          step: 'manual-target',
          confirmed: 1,
          confidence: targetedIssue.confidence,
        });

        detection = {
          hasIssues: true,
          confirmedIssues: [targetedIssue],
          categorizedIssues: {
            bySeverity: { high: targetedIssue.severity === 'high' ? [targetedIssue] : [], medium: targetedIssue.severity === 'medium' ? [targetedIssue] : [], low: targetedIssue.severity === 'low' ? [targetedIssue] : [] },
            byType: { [targetedIssue.type]: [targetedIssue] },
            byResource: { [targetedIssue.target]: [targetedIssue] },
            byNamespace: { [targetedIssue.namespace || 'default']: [targetedIssue] },
          },
          failureGroups: [],
          patterns: [],
          confidence: targetedIssue.confidence,
          summary: `Manual target selected: ${manualTarget.namespace}/${manualTarget.name}`,
          timestamp: new Date().toISOString(),
        };
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
      if (!detection) {
        this.setAgentStatus('detector', 'running', { step: 'confirming' });
        detection = await detector.detectIssues(analysis, currentState);
        this.setAgentStatus('detector', detection.hasIssues ? 'issues-confirmed' : 'success', {
          step: 'complete',
          confirmed: detection.confirmedIssues?.length || 0,
          confidence: detection.confidence,
        });
      }

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

      // Observer gate after detection: skip RCA and execution when trigger is false.
      if (!manualTarget && analysis.rcaDecision && analysis.rcaDecision.triggerRCA === false) {
        logger.info(`Observer gate reason: ${analysis.rcaDecision.reason}`);
        logger.timelineEvent('analysis', `RCA gate closed by Observer: ${analysis.rcaDecision.reason}`);

        if (attempts < this.maxRetries) {
          await this.sleep(this.retryDelayMs);
          currentState = await this.getClusterState();
          detection = null;
          continue;
        }

        finalResult = {
          success: true,
          attempts,
          finalHealth: analysis.healthy ? 'healthy' : 'monitoring',
          issuesFound: analysis.issues.length,
          fixesApplied: 0,
          rcaDecision: analysis.rcaDecision,
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

      if (rcaOutput.action === 'NO_ACTION' || !rcaOutput.rootCause) {
        this.setAgentStatus('rca', 'skipped', {
          step: 'complete',
          reason: rcaOutput.reasoning || 'RCA trigger conditions not satisfied',
        });

        logger.info(`Observer gate reason: ${analysis?.rcaDecision?.reason || 'n/a'}`);
        logger.info(`RCA action: ${rcaOutput.action || 'NO_ACTION'}`);
        logger.timelineEvent('rca', `RCA skipped: ${rcaOutput.reasoning || 'no action'}`);

        if (attempts < this.maxRetries) {
          await this.sleep(this.retryDelayMs);
          currentState = await this.getClusterState();
          detection = null;
          continue;
        }

        finalResult = {
          success: true,
          attempts,
          finalHealth: analysis.healthy ? 'healthy' : 'monitoring',
          issuesFound: analysis.issues.length,
          fixesApplied: 0,
          timeline: logger.getTimeline(),
        };
        break;
      }

      if (manualTarget?.kind === 'deployment') {
        rcaOutput.rootCauseType = 'deployment';
        rcaOutput.manualTargetKind = 'deployment';
      }
      logger.info(`Observer gate reason: ${analysis?.rcaDecision?.reason || 'manual-target override'}`);
      logger.info(`RCA action: ${rcaOutput.action || 'ANALYZE'} | rootCause: ${rcaOutput.rootCause || 'none'}`);
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

      if (manualTarget) {
        const manualSuccess = fixResult.status === 'success' || fixResult.status === 'simulated' || fixResult.status === 'partial';
        finalResult = {
          success: manualSuccess,
          attempts,
          finalHealth: manualSuccess ? 'healthy' : 'unhealthy',
          issuesFound: analysis.issues.length,
          fixesApplied: manualSuccess ? 1 : 0,
          target: manualTarget,
          timeline: logger.getTimeline(),
          error: manualSuccess ? undefined : (fixResult.error || fixResult.message || 'Manual target remediation failed'),
        };
        break;
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
        if (this.strictLive) {
          throw new Error(`Live metrics fetch failed in strict mode: ${error.message}`);
        }
        logger.warn('Falling back to mock data...');
      }
    }

    if (this.strictLive) {
      throw new Error('Strict live mode requires real metrics, but no metrics URL is configured.');
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

  /**
   * Read the explicit workload target from run options or environment.
   */
  getManualTarget(options = {}) {
    const name = this.normalizeWorkloadName(String(options.targetName || process.env.MANUAL_TARGET_NAME || '').trim());
    if (!name) {
      return null;
    }

    const namespace = String(options.targetNamespace || process.env.MANUAL_TARGET_NAMESPACE || 'default').trim() || 'default';
    const kind = String(options.targetKind || process.env.MANUAL_TARGET_KIND || 'pod').trim().toLowerCase() === 'deployment'
      ? 'deployment'
      : 'pod';

    return { name, namespace, kind };
  }

  /**
   * Resolve the selected target to a live pod record.
   */
  resolveManualTargetPod(clusterState, manualTarget) {
    const pods = clusterState.pods || [];
    if (manualTarget.kind === 'deployment') {
      const match = pods.find((pod) => this.getDeploymentNameFromPodName(pod.name) === manualTarget.name && (pod.namespace || 'default') === manualTarget.namespace);
      return match || null;
    }

    return pods.find(
      (pod) => this.normalizeWorkloadName(pod.name) === manualTarget.name && (pod.namespace || 'default') === manualTarget.namespace,
    ) || null;
  }

  /**
   * Build a focused issue for the selected pod based on live state.
   */
  buildManualTargetIssue(pod, manualTarget) {
    const status = String(pod.status || pod.phase || '').toLowerCase();
    const cpu = Number(pod.cpu || 0);
    const memory = Number(pod.memory || 0);
    const restarts = Number(pod.restarts || 0);
    const ready = pod.ready !== false;

    let issue = null;

    if (status.includes('crash') || status.includes('backoff') || status === 'failed') {
      issue = {
        pod: pod.name,
        namespace: pod.namespace || manualTarget.namespace,
        target: manualTarget.kind === 'deployment' ? this.getDeploymentNameFromPodName(pod.name) : pod.name,
        type: 'crash_loop',
        problem: `Targeted workload is in ${pod.status || pod.phase} state`,
        severity: 'high',
        metric: 'status',
        details: { phase: pod.status || pod.phase, targetKind: manualTarget.kind },
      };
    } else if (status === 'pending') {
      issue = {
        pod: pod.name,
        namespace: pod.namespace || manualTarget.namespace,
        target: manualTarget.kind === 'deployment' ? this.getDeploymentNameFromPodName(pod.name) : pod.name,
        type: 'pod_pending',
        problem: 'Targeted workload is pending',
        severity: 'medium',
        metric: 'status',
        details: { phase: pod.status || pod.phase, targetKind: manualTarget.kind },
      };
    } else if (restarts >= config.severity.thresholds.restarts.critical) {
      issue = {
        pod: pod.name,
        namespace: pod.namespace || manualTarget.namespace,
        target: manualTarget.kind === 'deployment' ? this.getDeploymentNameFromPodName(pod.name) : pod.name,
        type: 'excessive_restarts',
        problem: `Targeted workload has ${restarts} restarts`,
        severity: 'high',
        metric: 'restarts',
        value: restarts,
        details: { restarts, targetKind: manualTarget.kind },
      };
    } else if (cpu >= config.severity.thresholds.cpu.high) {
      issue = {
        pod: pod.name,
        namespace: pod.namespace || manualTarget.namespace,
        target: manualTarget.kind === 'deployment' ? this.getDeploymentNameFromPodName(pod.name) : pod.name,
        type: 'high_cpu',
        problem: `Targeted workload is using ${cpu}% CPU`,
        severity: 'high',
        metric: 'cpu',
        value: cpu,
        details: { cpu, targetKind: manualTarget.kind },
      };
    } else if (memory >= config.severity.thresholds.memory.high) {
      issue = {
        pod: pod.name,
        namespace: pod.namespace || manualTarget.namespace,
        target: manualTarget.kind === 'deployment' ? this.getDeploymentNameFromPodName(pod.name) : pod.name,
        type: 'high_memory',
        problem: `Targeted workload is using ${memory}% memory`,
        severity: 'high',
        metric: 'memory',
        value: memory,
        details: { memory, targetKind: manualTarget.kind },
      };
    } else if (!ready) {
      issue = {
        pod: pod.name,
        namespace: pod.namespace || manualTarget.namespace,
        target: manualTarget.kind === 'deployment' ? this.getDeploymentNameFromPodName(pod.name) : pod.name,
        type: 'not_ready',
        problem: 'Targeted workload is not ready',
        severity: 'medium',
        metric: 'readiness',
        details: { ready, targetKind: manualTarget.kind },
      };
    }

    if (!issue) {
      return null;
    }

    return {
      ...issue,
      confidence: 95,
      detectionId: `${issue.target}-${Date.now()}-manual`,
      isFlapping: false,
      flappingCount: 0,
      confirmed: true,
      confirmationTime: new Date().toISOString(),
    };
  }

  /**
   * Infer a deployment name from a pod name.
   */
  getDeploymentNameFromPodName(podName) {
    const baseName = this.normalizeWorkloadName(String(podName || '').trim());
    const parts = baseName.split('-');
    if (parts.length >= 3) {
      return parts.slice(0, -2).join('-');
    }
    if (parts.length >= 2) {
      return parts.slice(0, -1).join('-');
    }
    return baseName;
  }

  /**
   * Strip display-only suffixes from workload names.
   */
  normalizeWorkloadName(name) {
    return String(name || '')
      .replace(/\s*\(deployment\)\s*$/i, '')
      .trim();
  }

  /**
   * Manually heal a specific pod/resource
   * This can be called from the dashboard or API
   */
  async healResource(podName, namespace = 'default', force = false) {
    const mode = this.getExecutionMode();

    if (mode.dryRun && !force) {
      return {
        status: 'blocked',
        message: 'System is in dry-run mode. Use force=true to execute anyway.',
      };
    }

    // Temporarily disable dry run if forcing
    const originalDryRun = mode.dryRun;
    if (force && originalDryRun) {
      executor.setDryRun(false);
    }

    try {
      // Get current cluster state
      const clusterState = await this.getClusterState();

      // Create a synthetic RCA output for this pod
      const rcaOutput = {
        rootCause: podName,
        rootCauseType: 'pod',
        failureChain: ['manual-heal'],
        confidence: 100,
        reasoning: `Manual heal request for ${podName}`,
        chainDetails: [{
          name: podName,
          type: 'pod',
          depth: 0,
          health: { healthy: false, reason: 'Manual heal requested' },
        }],
        affectedResources: [{ name: podName, type: 'pod', health: { healthy: false } }],
      };

      // Execute the fix
      const result = await executor.executeFix(rcaOutput, clusterState);

      return {
        status: result.status,
        podName,
        namespace,
        fixType: result.fixType,
        message: result.message,
        verification: result.verification,
      };
    } finally {
      // Restore dry run mode
      if (force && originalDryRun) {
        executor.setDryRun(true);
      }
    }
  }

  /**
   * Execute all recommended fixes for current issues
   */
  async healAll(force = false) {
    const result = await this.runSelfHealingSystem({ forceHealAll: force });
    return result;
  }

  /**
   * Get current system status including execution mode
   */
  getSystemStatus() {
    return {
      isRunning: this.isRunning,
      iteration: this.iteration,
      executionMode: this.getExecutionMode(),
      metricsUrl: this.metricsUrl,
    };
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
