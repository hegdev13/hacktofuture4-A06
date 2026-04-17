/**
 * Executioner Agent
 * Executes fixes based on RCA output with abstraction layer for K8s operations
 */

const config = require('../config');
const logger = require('../utils/logger');
const memory = require('./memory');
const { execFileSync } = require('child_process');

/**
 * Checkpoint Manager - stores state before execution for rollback capability
 */
class CheckpointManager {
  constructor() {
    this.checkpoints = new Map(); // issueId -> checkpoint data
    this.maxAgeMs = 30 * 60 * 1000; // 30 minutes max checkpoint age
  }

  /**
   * Capture checkpoint before executing fix
   */
  async captureCheckpoint(issueId, target, namespace, strategy) {
    try {
      const timestamp = new Date().toISOString();
      const checkpoint = {
        issueId,
        target,
        namespace,
        strategy,
        timestamp,
        state: {},
      };

      // Get deployment state if applicable
      if (strategy.type === 'restart_deployment' ||
          strategy.type === 'scale_up' ||
          strategy.type === 'scale_down' ||
          strategy.type === 'rollback') {
        const depState = await this.captureDeploymentState(target, namespace);
        checkpoint.state.deployment = depState;
      }

      // Get pod state for pod restarts
      if (strategy.type === 'restart_pod') {
        const podState = await this.capturePodState(target, namespace);
        checkpoint.state.pod = podState;
      }

      // Store checkpoint
      this.checkpoints.set(issueId, checkpoint);

      // Cleanup old checkpoints
      this.cleanupOldCheckpoints();

      logger.info(`[CHECKPOINT] ✅ Captured checkpoint for ${issueId}`);
      return { ok: true, checkpoint };
    } catch (error) {
      logger.error(`[CHECKPOINT] ❌ Failed to capture checkpoint: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  /**
   * Capture deployment state
   */
  captureDeploymentState(deploymentName, namespace) {
    try {
      const args = ['get', 'deployment', deploymentName, '-n', namespace, '-o', 'json'];
      const output = execFileSync('kubectl', args, {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const deployment = JSON.parse(output);

      return {
        name: deployment.metadata?.name,
        namespace: deployment.metadata?.namespace,
        replicas: deployment.spec?.replicas,
        strategy: deployment.spec?.strategy,
        selector: deployment.spec?.selector,
        template: deployment.spec?.template,
        revision: deployment.metadata?.annotations?.['deployment.kubernetes.io/revision'],
        resourceVersion: deployment.metadata?.resourceVersion,
        raw: deployment,
      };
    } catch (error) {
      logger.warn(`[CHECKPOINT] Could not capture deployment state: ${error.message}`);
      return null;
    }
  }

  /**
   * Capture pod state
   */
  capturePodState(podName, namespace) {
    try {
      const args = ['get', 'pod', podName, '-n', namespace, '-o', 'json'];
      const output = execFileSync('kubectl', args, {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const pod = JSON.parse(output);

      return {
        name: pod.metadata?.name,
        namespace: pod.metadata?.namespace,
        labels: pod.metadata?.labels,
        ownerReferences: pod.metadata?.ownerReferences,
        spec: {
          containers: pod.spec?.containers?.map(c => ({
            name: c.name,
            image: c.image,
            resources: c.resources,
            env: c.env,
          })),
          restartPolicy: pod.spec?.restartPolicy,
        },
        resourceVersion: pod.metadata?.resourceVersion,
        raw: pod,
      };
    } catch (error) {
      logger.warn(`[CHECKPOINT] Could not capture pod state: ${error.message}`);
      return null;
    }
  }

  /**
   * Get checkpoint for issue
   */
  getCheckpoint(issueId) {
    return this.checkpoints.get(issueId);
  }

  /**
   * Rollback to checkpoint
   */
  async rollbackToCheckpoint(issueId) {
    const checkpoint = this.checkpoints.get(issueId);
    if (!checkpoint) {
      return {
        ok: false,
        error: 'No checkpoint found for issue',
      };
    }

    const results = [];

    try {
      logger.info(`[ROLLBACK] 🔄 Starting rollback for ${issueId}`);

      // Rollback deployment if we have state
      if (checkpoint.state?.deployment) {
        const depResult = await this.rollbackDeployment(
          checkpoint.state.deployment,
          checkpoint.strategy
        );
        results.push({ type: 'deployment', ...depResult });
      }

      // For pod restarts, checkpoint is informational - pods self-heal
      // But we can verify owner reference still exists
      if (checkpoint.state?.pod) {
        results.push({
          type: 'pod',
          ok: true,
          message: 'Pod checkpoint recorded for reference only',
        });
      }

      const allOk = results.every(r => r.ok);

      logger.info(`[ROLLBACK] ✅ Rollback ${allOk ? 'completed' : 'partial'} for ${issueId}`);

      return {
        ok: allOk,
        results,
        message: allOk ? 'Rollback successful' : 'Rollback completed with issues',
      };
    } catch (error) {
      logger.error(`[ROLLBACK] ❌ Rollback failed: ${error.message}`);
      return {
        ok: false,
        error: error.message,
        results,
      };
    }
  }

  /**
   * Rollback deployment to previous state
   */
  rollbackDeployment(deploymentState, strategy) {
    try {
      const { name, namespace, replicas, revision } = deploymentState;

      // If we have a revision, use rollout undo
      if (revision && strategy.type !== 'scale_up') {
        logger.info(`[ROLLBACK] Using rollout undo for ${namespace}/${name}`);
        const args = ['rollout', 'undo', 'deployment', name, '-n', namespace];
        const output = execFileSync('kubectl', args, {
          encoding: 'utf8',
          timeout: 60000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Wait for rollback to complete
        this.waitForRollout(name, namespace);

        return {
          ok: true,
          method: 'rollout_undo',
          output: output.trim(),
        };
      }

      // For scale operations, restore original replica count
      if (strategy.type === 'scale_up' && replicas !== undefined) {
        logger.info(`[ROLLBACK] Restoring replica count ${replicas} for ${namespace}/${name}`);
        const args = ['scale', 'deployment', name, '-n', namespace, `--replicas=${replicas}`];
        const output = execFileSync('kubectl', args, {
          encoding: 'utf8',
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        return {
          ok: true,
          method: 'scale_restore',
          replicas,
          output: output.trim(),
        };
      }

      return {
        ok: true,
        method: 'none',
        message: 'No rollback action needed',
      };
    } catch (error) {
      logger.error(`[ROLLBACK] Deployment rollback failed: ${error.message}`);
      return {
        ok: false,
        error: error.message,
      };
    }
  }

  /**
   * Wait for rollout to complete
   */
  waitForRollout(deploymentName, namespace) {
    try {
      const args = ['rollout', 'status', 'deployment', deploymentName, '-n', namespace, '--timeout=60s'];
      execFileSync('kubectl', args, {
        encoding: 'utf8',
        timeout: 65000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { ok: true };
    } catch (error) {
      logger.warn(`[ROLLBACK] Rollout status check: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  /**
   * Clear checkpoint
   */
  clearCheckpoint(issueId) {
    const existed = this.checkpoints.has(issueId);
    this.checkpoints.delete(issueId);
    if (existed) {
      logger.info(`[CHECKPOINT] Cleared checkpoint for ${issueId}`);
    }
    return existed;
  }

  /**
   * Cleanup old checkpoints
   */
  cleanupOldCheckpoints() {
    const now = Date.now();
    for (const [issueId, checkpoint] of this.checkpoints.entries()) {
      const checkpointTime = new Date(checkpoint.timestamp).getTime();
      if (now - checkpointTime > this.maxAgeMs) {
        this.checkpoints.delete(issueId);
        logger.info(`[CHECKPOINT] Cleaned up old checkpoint for ${issueId}`);
      }
    }
  }

  /**
   * Get all checkpoints
   */
  getAllCheckpoints() {
    return Array.from(this.checkpoints.entries()).map(([issueId, data]) => ({
      issueId,
      ...data,
    }));
  }
}

// Create singleton checkpoint manager
const checkpointManager = new CheckpointManager();

class ExecutionerAgent {
  constructor() {
    this.strategies = config.execution.strategies;
    this.dryRun = config.execution.dryRun;
    this.timeoutMs = config.execution.timeoutMs || 120000;
    this.verifyFixes = config.execution.verifyFixes !== false; // default true
    this.verifyTimeoutMs = config.execution.verifyTimeoutMs || 120000;
    this.protectedNamespaces = new Set([
      'kube-system',
      'kube-public',
      'kube-node-lease',
      'local-path-storage',
      'ingress-nginx',
    ]);
    this.llmStrategy = this.readLLMStrategyFromEnv();
    this.llmOptionSteps = this.readLLMOptionStepsFromEnv();
  }

  readLLMOptionStepsFromEnv() {
    const raw = String(process.env.LLM_OPTION_STEPS_JSON || '').trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((s) => String(s || '').trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  readLLMStrategyFromEnv() {
    const type = String(process.env.LLM_STRATEGY_TYPE || '').trim();
    if (!type) return null;

    const allowed = new Set(['restart_pod', 'restart_deployment', 'scale_up', 'rollback']);
    if (!allowed.has(type)) return null;

    const replicasRaw = Number(process.env.LLM_STRATEGY_REPLICAS || 0);
    const replicas = Number.isFinite(replicasRaw) && replicasRaw > 0 ? Math.floor(replicasRaw) : undefined;

    return {
      type,
      replicas,
      reason: String(process.env.LLM_STRATEGY_REASON || '').trim(),
    };
  }

  /**
   * Run kubectl with args directly (no shell) for better cross-platform reliability.
   */
  runKubectl(args, timeoutMs = this.timeoutMs) {
    const output = execFileSync('kubectl', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    return (output || '').trim();
  }

  /**
   * Execute fix based on RCA output
   */
  async executeFix(rcaOutput, clusterState) {
    logger.timelineEvent('fix', `Planning fix for ${rcaOutput.rootCause}`);

    // Check memory for recommended fixes
    const recommendation = memory.getRecommendedFix(
      rcaOutput.failureChain[0] || 'unknown',
      rcaOutput.failureChain.join('|')
    );

    // Determine best fix strategy
    const strategy = this.determineStrategy(rcaOutput, recommendation, clusterState);

    // Validate strategy
    if (!this.validateStrategy(strategy)) {
      return {
        fixType: 'none',
        target: rcaOutput.rootCause,
        namespace: 'default',
        status: 'failed',
        message: 'Invalid or unsupported fix strategy',
        error: 'Strategy validation failed',
      };
    }

    // 🔹 Step 1: Pre-checkpoint - Capture current state before execution
    logger.info(`[CHECKPOINT] Capturing state before executing ${strategy.type}`);
    const checkpoint = await checkpointManager.captureCheckpoint(
      rcaOutput.issueId || 'unknown',
      strategy.target,
      strategy.namespace,
      strategy
    );

    if (!checkpoint.ok) {
      logger.warn(`[CHECKPOINT] Failed to capture checkpoint: ${checkpoint.error}`);
      // Continue execution but note the checkpoint failure
    }

    // 🔹 Step 2: Execute the strategy
    let result = await this.executeStrategy(strategy, rcaOutput, clusterState);

    // Attach checkpoint info to result for SRE review
    result.checkpoint = {
      captured: checkpoint.ok,
      issueId: rcaOutput.issueId,
      canRollback: checkpoint.ok,
    };

    // 🔹 Step 3: Monitor/Verify the fix if it succeeded and we're not in dry run
    if (result.status === 'success' && result.action && !this.dryRun && this.verifyFixes) {
      logger.info(`[VERIFY] Starting verification after execution`);
      const verification = await this.verifyFix(result.action, clusterState);
      result.verification = verification;

      if (!verification.verified) {
        result.status = 'partial';
        result.message += ` (Verification failed: ${verification.reason})`;
        logger.error(`[VERIFY] ❌ Verification failed: ${verification.reason}`);

        // If verification failed, auto-rollback if configured
        if (config.execution.autoRollbackOnVerificationFailure && checkpoint.ok) {
          logger.info(`[ROLLBACK] Auto-rolling back due to verification failure`);
          const rollbackResult = await checkpointManager.rollbackToCheckpoint(rcaOutput.issueId);
          result.rollback = rollbackResult;
        }
      } else {
        result.message += ` (Verified: ${verification.reason})`;
        logger.info(`[VERIFY] ✅ Fix verified: ${verification.reason}`);
      }
    }

    // Store learning
    memory.storeLearning({
      issueType: rcaOutput.failureChain[0] || 'unknown',
      problemSignature: rcaOutput.failureChain.join('|'),
      fixType: strategy.type,
      target: strategy.target,
      success: result.status === 'success' || result.status === 'simulated',
      beforeState: rcaOutput,
      afterState: result,
    });

    logger.timelineEvent(
      result.status === 'success' || result.status === 'simulated' ? 'success' : 'error',
      `Fix execution ${result.status}`,
      { fixType: result.fixType, target: result.target, checkpoint: checkpoint.ok }
    );

    return result;
  }

  /**
   * Get checkpoint manager for external access
   */
  getCheckpointManager() {
    return checkpointManager;
  }

  /**
   * Rollback a fix by issueId
   */
  async rollbackFix(issueId) {
    logger.info(`[ROLLBACK] Initiating rollback for ${issueId}`);
    const result = await checkpointManager.rollbackToCheckpoint(issueId);
    if (result.ok) {
      checkpointManager.clearCheckpoint(issueId);
    }
    return result;
  }

  /**
   * Check if checkpoint exists for issue
   */
  hasCheckpoint(issueId) {
    return checkpointManager.getCheckpoint(issueId) !== undefined;
  }

  /**
   * Determine the best fix strategy
   */
  determineStrategy(rcaOutput, recommendation, clusterState) {
    const rootCause = rcaOutput.rootCause;
    const rootCauseType = rcaOutput.rootCauseType;
    const manualTargetKind = rcaOutput.manualTargetKind;
    const manualTargetNamespace = rcaOutput.manualTargetNamespace;
    const failureChain = rcaOutput.failureChain;

    // First issue in chain gives context
    const primaryIssue = failureChain[0] || '';
    const primaryReason = rcaOutput.chainDetails?.[0]?.health?.reason || '';
    const primaryIssueLower = String(primaryIssue || '').toLowerCase();
    const primaryReasonLower = String(primaryReason || '').toLowerCase();
    let strategy;

    if (this.llmOptionSteps.length > 0) {
      const namespace = manualTargetNamespace || this.getNamespace(rootCause, clusterState);
      return {
        type: 'runbook_steps',
        target: this.getDeploymentName(rootCause, clusterState),
        namespace,
        steps: this.llmOptionSteps,
        priority: 0,
      };
    }

    if (this.llmStrategy) {
      strategy = {
        type: this.llmStrategy.type,
        target: this.llmStrategy.type === 'restart_pod' ? rootCause : this.getDeploymentName(rootCause, clusterState),
        namespace: manualTargetNamespace || this.getNamespace(rootCause, clusterState),
        replicas: this.llmStrategy.replicas,
        priority: 0,
      };

      if (strategy.type === 'scale_up' && (!strategy.replicas || strategy.replicas < 1)) {
        strategy.replicas = this.calculateReplicas(rootCause, clusterState, 1);
      }

      logger.info(`Using LLM-selected strategy: ${strategy.type}${this.llmStrategy.reason ? ` (${this.llmStrategy.reason})` : ''}`);
      return strategy;
    }

    if (
      primaryIssueLower.includes('image_pull') ||
      primaryIssueLower.includes('imagepull') ||
      primaryReasonLower.includes('imagepull') ||
      primaryReasonLower.includes('errimagepull') ||
      primaryReasonLower.includes('invalidimage')
    ) {
      strategy = {
        type: 'rollback',
        target: this.getDeploymentName(rootCause, clusterState),
        namespace: this.getNamespace(rootCause, clusterState),
        priority: 0,
      };
      return strategy;
    }

    // Strategy selection logic
    strategy = {
      type: manualTargetKind === 'deployment' || rootCauseType === 'deployment' ? 'restart_deployment' : 'restart_pod',
      target: rootCause,
      namespace: this.getNamespace(rootCause, clusterState),
      priority: 1,
    };

    const deploymentForRoot = this.getDeploymentName(rootCause, clusterState);
    const rootNamespace = this.getNamespace(rootCause, clusterState);
    const siblingPods = (clusterState.pods || []).filter(
      (p) => this.getDeploymentName(p.name, clusterState) === deploymentForRoot && (p.namespace || 'default') === rootNamespace,
    );
    const hasHealthySibling = siblingPods.some((p) => String(p.status || p.phase || '').toLowerCase() === 'running');
    const hasUnhealthySibling = siblingPods.some((p) => {
      const s = String(p.status || p.phase || '').toLowerCase();
      return s.includes('failed') || s.includes('pending') || s.includes('backoff') || s.includes('crash') || s.includes('error');
    });

    if (manualTargetKind === 'pod' && hasHealthySibling && hasUnhealthySibling) {
      strategy = {
        type: 'rollback',
        target: deploymentForRoot,
        namespace: rootNamespace,
        priority: 0,
      };
      return strategy;
    }

    if (manualTargetKind === 'deployment' || rootCauseType === 'deployment') {
      strategy = {
        type: 'restart_deployment',
        target: rootCause,
        namespace: this.getNamespace(rootCause, clusterState),
        priority: 1,
      };
    }

    // High restart count → restart
    if (primaryReason.includes('restart') || primaryIssue.includes('restart')) {
      // Check if it's a database or critical service - use rollout restart instead
      if (rootCause.includes('db') || rootCause.includes('database') ||
          rootCause.includes('postgres') || rootCause.includes('redis') ||
          rootCause.includes('mongo') || rootCause.includes('mysql')) {
        strategy = {
          type: 'restart_deployment',
          target: this.getDeploymentName(rootCause, clusterState),
          namespace: this.getNamespace(rootCause, clusterState),
          priority: 1,
        };
      } else {
        strategy = {
          type: 'restart_pod',
          target: rootCause,
          namespace: this.getNamespace(rootCause, clusterState),
          priority: 1,
        };
      }
    }

    // OOM or resource pressure → scale up
    else if (primaryReason.includes('memory') || primaryReason.includes('OOM')) {
      strategy = {
        type: 'scale_up',
        target: this.getDeploymentName(rootCause, clusterState),
        namespace: this.getNamespace(rootCause, clusterState),
        replicas: this.calculateReplicas(rootCause, clusterState, 1),
        priority: 2,
      };
    }

    // CPU pressure → scale up or restart
    else if (primaryReason.includes('CPU')) {
      strategy = {
        type: 'scale_up',
        target: this.getDeploymentName(rootCause, clusterState),
        namespace: this.getNamespace(rootCause, clusterState),
        replicas: this.calculateReplicas(rootCause, clusterState, 1),
        priority: 2,
      };
    }

    // Pending state → check dependencies
    else if (primaryReason.includes('pending')) {
      // Check if dependency issue
      if (rcaOutput.chainDetails?.some(d => d.depth > 0 && !d.health.healthy)) {
        const dep = rcaOutput.chainDetails.find(d => d.depth > 0 && !d.health.healthy);
        strategy = {
          type: 'restart_dependency_first',
          target: dep.name,
          originalTarget: rootCause,
          namespace: this.getNamespace(dep.name, clusterState),
          priority: 3,
        };
      } else {
        strategy = {
          type: 'restart_pod',
          target: rootCause,
          namespace: this.getNamespace(rootCause, clusterState),
          priority: 1,
        };
      }
    }

    // Cascading failure → restart root cause
    else if (rcaOutput.affectedResources?.length > 2) {
      strategy = {
        type: 'restart_pod',
        target: rootCause,
        namespace: this.getNamespace(rootCause, clusterState),
        priority: 1,
      };
    }

    // Connection issues → restart
    else if (primaryIssue.includes('connection') || primaryIssue.includes('timeout')) {
      strategy = {
        type: 'restart_pod',
        target: rootCause,
        namespace: this.getNamespace(rootCause, clusterState),
        priority: 1,
      };
    }

    // Apply recommendation if confidence is high enough
    const explicitDeploymentTarget = manualTargetKind === 'deployment' || rootCauseType === 'deployment';
    const preferred = String(process.env.REMEDIATION_PREFERENCE || '').trim().toLowerCase();

    if (preferred === 'restart-workload') {
      strategy = {
        type: explicitDeploymentTarget ? 'restart_deployment' : 'restart_pod',
        target: explicitDeploymentTarget ? this.getDeploymentName(rootCause, clusterState) : rootCause,
        namespace: this.getNamespace(rootCause, clusterState),
        priority: 1,
      };
    } else if (preferred === 'scale-replicas') {
      strategy = {
        type: 'scale_up',
        target: this.getDeploymentName(rootCause, clusterState),
        namespace: this.getNamespace(rootCause, clusterState),
        replicas: this.calculateReplicas(rootCause, clusterState, 1),
        priority: 1,
      };
    } else if (preferred === 'dependency-first') {
      const dep = rcaOutput.chainDetails?.find(d => d.depth > 0 && !d.health.healthy);
      strategy = {
        type: dep ? 'restart_dependency_first' : (explicitDeploymentTarget ? 'restart_deployment' : 'restart_pod'),
        target: dep ? dep.name : rootCause,
        originalTarget: rootCause,
        namespace: this.getNamespace(dep ? dep.name : rootCause, clusterState),
        priority: 1,
      };
    }

    if (!explicitDeploymentTarget && recommendation && recommendation.confidence >= config.memory.minConfidenceForLearning) {
      logger.info(`Using recommended fix: ${recommendation.fixType} (confidence: ${recommendation.confidence}%)`);
      strategy.type = recommendation.fixType;
    }

    return strategy;
  }

  /**
   * Execute the chosen strategy
   */
  async executeStrategy(strategy, rcaOutput, clusterState) {
    const startTime = Date.now();

    try {
      let result;

      switch (strategy.type) {
        case 'runbook_steps':
          result = this.executeRunbookSteps(strategy.steps, strategy.namespace);
          break;

        case 'restart_pod':
          result = this.restartPod(strategy.target, strategy.namespace);
          break;

        case 'restart_deployment':
          result = this.restartDeployment(strategy.target, strategy.namespace);
          break;

        case 'scale_up':
          result = this.scaleDeployment(
            strategy.target,
            strategy.namespace,
            strategy.replicas
          );
          break;

        case 'scale_down':
          result = this.scaleDeployment(
            strategy.target,
            strategy.namespace,
            Math.max(1, (this.getCurrentReplicas(strategy.target, clusterState) || 1) - 1)
          );
          break;

        case 'rollback':
          result = this.rollbackDeployment(strategy.target, strategy.namespace);
          break;

        case 'restart_dependency_first':
          result = await this.restartDependencyFirst(strategy, rcaOutput, clusterState);
          break;

        case 'cordon_node':
          result = this.cordonNode(strategy.target);
          break;

        case 'drain_node':
          result = this.drainNode(strategy.target);
          break;

        default:
          result = {
            status: 'failed',
            message: `Unknown strategy: ${strategy.type}`,
          };
      }

      const duration = Date.now() - startTime;

      return {
        fixType: strategy.type,
        target: strategy.target,
        namespace: strategy.namespace,
        status: result.status,
        message: result.message,
        duration,
        action: result.action,
        metadata: result.metadata || {},
      };

    } catch (error) {
      return {
        fixType: strategy.type,
        target: strategy.target,
        namespace: strategy.namespace,
        status: 'failed',
        message: `Execution failed: ${error.message}`,
        error: error.stack,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Restart a pod
   */
  restartPod(podName, namespace) {
    const ns = namespace || 'default';
    const action = {
      type: 'DELETE',
      resource: 'pod',
      name: podName,
      namespace: ns,
      message: `Restarting pod ${ns}/${podName}`,
    };

    let result = this.executeK8sAction(action);

    // If target isn't a pod but is a deployment name, heal by restarting deployment
    // (restartDeployment will auto-scale from 0 replicas to 1 before rollout restart).
    if (
      result.status === 'failed' &&
      /notfound|not found/i.test(String(result.message || result.error || '')) &&
      this.resourceExists('deployment', podName, ns)
    ) {
      logger.warn(`Pod ${ns}/${podName} not found; falling back to deployment restart`);
      result = this.restartDeployment(podName, ns);
    }

    return { ...result, action: result.action || action };
  }

  resourceExists(resource, name, namespace) {
    try {
      const nsArgs = namespace ? ['-n', namespace] : [];
      this.runKubectl(['get', resource, name, ...nsArgs], 15000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Restart a deployment (rollout restart)
   */
  restartDeployment(deploymentName, namespace) {
    const ns = namespace || 'default';

    // If deployment is intentionally or accidentally at 0 replicas, restore one replica first so healing is visible.
    const replicaCheck = this.getDeploymentReplicaStatus(deploymentName, ns);
    if (replicaCheck.ok && replicaCheck.specReplicas === 0) {
      logger.info(`Deployment ${ns}/${deploymentName} is at 0 replicas; scaling to 1 before restart`);
      const scaleAction = {
        type: 'SCALE',
        resource: 'deployment',
        name: deploymentName,
        namespace: ns,
        replicas: 1,
        message: `Scaling deployment ${ns}/${deploymentName} to 1 replica before restart`,
      };
      const scaleResult = this.executeK8sAction(scaleAction);
      if (scaleResult.status !== 'success' && scaleResult.status !== 'simulated') {
        return {
          status: 'failed',
          message: `Failed to scale deployment ${ns}/${deploymentName} before restart: ${scaleResult.message}`,
          action: scaleAction,
          metadata: { scaledFromZero: true },
        };
      }
    }

    const action = {
      type: 'RESTART',
      resource: 'deployment',
      name: deploymentName,
      namespace: ns,
      message: `Rolling out restart for deployment ${ns}/${deploymentName}`,
    };

    const result = this.executeK8sAction(action);
    return { ...result, action };
  }

  getDeploymentReplicaStatus(deploymentName, namespace) {
    try {
      const output = this.runKubectl(['get', 'deployment', deploymentName, '-n', namespace, '-o', 'json'], 15000);
      const dep = JSON.parse(output);
      return {
        ok: true,
        specReplicas: Number(dep?.spec?.replicas ?? 1),
        availableReplicas: Number(dep?.status?.availableReplicas ?? 0),
      };
    } catch (error) {
      logger.warn(`Could not read deployment replica status for ${namespace}/${deploymentName}: ${error.message}`);
      return { ok: false, specReplicas: null, availableReplicas: null };
    }
  }

  /**
   * Scale a deployment
   */
  scaleDeployment(deploymentName, namespace, replicas) {
    const action = {
      type: 'SCALE',
      resource: 'deployment',
      name: deploymentName,
      namespace,
      replicas,
      message: `Scaling deployment ${namespace}/${deploymentName} to ${replicas} replicas`,
    };

    const result = this.executeK8sAction(action);
    return { ...result, action };
  }

  /**
   * Rollback a deployment
   */
  rollbackDeployment(deploymentName, namespace) {
    const action = {
      type: 'ROLLBACK',
      resource: 'deployment',
      name: deploymentName,
      namespace,
      message: `Rolling back deployment ${namespace}/${deploymentName}`,
    };

    const result = this.executeK8sAction(action);
    return { ...result, action };
  }

  /**
   * Restart dependency first, then original target
   */
  async restartDependencyFirst(strategy, rcaOutput, clusterState) {
    // First restart dependency
    const depResult = this.restartPod(strategy.target, strategy.namespace);

    if (depResult.status !== 'success') {
      return {
        status: 'failed',
        message: `Failed to restart dependency ${strategy.target}: ${depResult.message}`,
        metadata: { phase: 'dependency', dependency: strategy.target },
        action: depResult.action,
      };
    }

    // Verify dependency restarted before proceeding
    if (!this.dryRun && this.verifyFixes) {
      const depVerification = await this.verifyFix(depResult.action, clusterState);
      if (!depVerification.verified) {
        return {
          status: 'failed',
          message: `Dependency ${strategy.target} did not recover: ${depVerification.reason}`,
          metadata: { phase: 'dependency-verification', dependency: strategy.target },
          action: depResult.action,
        };
      }
    }

    // Then restart original target
    const originalResult = this.restartPod(
      strategy.originalTarget,
      this.getNamespace(strategy.originalTarget, clusterState)
    );

    return {
      status: originalResult.status,
      message: `Restarted dependency ${strategy.target}, then ${strategy.originalTarget}: ${originalResult.message}`,
      metadata: {
        dependency: strategy.target,
        original: strategy.originalTarget,
      },
      action: originalResult.action,
    };
  }

  /**
   * Cordon a node
   */
  cordonNode(nodeName) {
    const action = {
      type: 'CORDON',
      resource: 'node',
      name: nodeName,
      namespace: null,
      message: `Cordoning node ${nodeName}`,
    };

    const result = this.executeK8sAction(action);
    return { ...result, action };
  }

  /**
   * Drain a node
   */
  drainNode(nodeName) {
    const action = {
      type: 'DRAIN',
      resource: 'node',
      name: nodeName,
      namespace: null,
      message: `Draining node ${nodeName}`,
    };

    const result = this.executeK8sAction(action);
    return { ...result, action };
  }

  /**
   * Execute K8s action (abstraction layer)
   * Supports both real kubectl execution and dry-run mode
   */
  executeK8sAction(action) {
    // Log the action
    logger.info(`K8s Action: ${action.message || action.type}`);
    logger.debug('Action details', action);

    if (this.dryRun) {
      // In dry run mode, simulate success
      logger.info('[DRY RUN] Action would be executed:', action);
      return {
        status: 'simulated',
        message: `[DRY RUN] ${action.message || action.type} - Not actually executed`,
        metadata: { dryRun: true, action },
      };
    }

    // Real kubectl execution
    try {
      const result = this.executeKubectl(action);
      return {
        status: 'success',
        message: `Executed ${action.type} on ${action.resource} ${action.name}`,
        metadata: { action, kubectlOutput: result.output },
      };
    } catch (error) {
      logger.error(`Kubectl execution failed: ${error.message}`);
      return {
        status: 'failed',
        message: error.message,
        error: error.stderr || error.message,
      };
    }
  }

  /**
   * Execute actual kubectl command
   */
  executeKubectl(action) {
    const { type, resource, name, namespace, replicas } = action;

    let args = [];
    const ns = namespace ? ['-n', namespace] : [];

    switch (type) {
      case 'DELETE':
        // Delete a pod (triggers restart via ReplicaSet/Deployment)
        args = ['delete', resource, name, ...ns, '--grace-period=30'];
        break;

      case 'SCALE':
        // Scale a deployment
        if (resource === 'deployment') {
          args = ['scale', resource, name, ...ns, `--replicas=${replicas}`];
        } else {
          throw new Error(`Cannot scale resource type: ${resource}`);
        }
        break;

      case 'ROLLBACK':
        // Rollback a deployment
        args = ['rollout', 'undo', resource, name, ...ns];
        break;

      case 'CORDON':
        // Cordon a node
        args = ['cordon', name];
        break;

      case 'DRAIN':
        // Drain a node
        args = ['drain', name, '--ignore-daemonsets', '--delete-local-data', '--force'];
        break;

      case 'RESTART':
        // Restart a deployment (rollout restart)
        args = ['rollout', 'restart', resource, name, ...ns];
        break;

      default:
        throw new Error(`Unknown action type: ${type}`);
    }

    logger.info(`Executing: kubectl ${args.join(' ')}`);

    const output = this.runKubectl(args, this.timeoutMs);

    return { output, command: `kubectl ${args.join(' ')}` };
  }

  tokenizeCommand(command) {
    const matches = String(command || '').match(/(?:[^\s\"]+|\"[^\"]*\")+/g) || [];
    return matches.map((t) => t.replace(/^\"|\"$/g, ''));
  }

  ensureNamespaceArg(args, namespace) {
    const hasNamespace = args.includes('-n') || args.includes('--namespace') || args.includes('-A') || args.includes('--all-namespaces');
    if (hasNamespace || !namespace) return args;
    return [...args, '-n', namespace];
  }

  executeRunbookSteps(steps, namespace) {
    if (!Array.isArray(steps) || steps.length === 0) {
      return {
        status: 'failed',
        message: 'Selected option contains no executable steps',
      };
    }

    const outputs = [];

    try {
      for (const step of steps) {
        const tokens = this.tokenizeCommand(step);
        if (tokens.length === 0) continue;
        if (tokens[0] !== 'kubectl') {
          return {
            status: 'failed',
            message: `Unsupported step (only kubectl commands are allowed): ${step}`,
          };
        }

        const args = this.ensureNamespaceArg(tokens.slice(1), namespace);
        const output = this.runKubectl(args, this.timeoutMs);
        outputs.push({ step, command: `kubectl ${args.join(' ')}`, output });
      }

      return {
        status: this.dryRun ? 'simulated' : 'success',
        message: `Executed ${steps.length} selected option step(s)`,
        action: {
          type: 'RUNBOOK',
          resource: 'deployment',
          name: 'selected-option',
          namespace,
          message: 'Executed selected remediation option commands',
        },
        metadata: { steps: outputs },
      };
    } catch (error) {
      return {
        status: 'failed',
        message: `Runbook step execution failed: ${error.message}`,
      };
    }
  }

  /**
   * Verify that a fix was applied successfully
   */
  async verifyFix(action, clusterState) {
    if (!this.verifyFixes) {
      logger.info('[VERIFICATION] Verification disabled, skipping');
      return { verified: true, reason: 'Verification disabled' };
    }

    const { resource, name, namespace, type } = action;
    const startTime = Date.now();
    const checkInterval = 2000; // Check every 2 seconds
    const maxWaitTime = this.verifyTimeoutMs;

    logger.info(`[VERIFY] Verifying fix for ${resource}/${name}...`);

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const args = ['get', resource, name, ...(namespace ? ['-n', namespace] : []), '-o', 'json'];
        const output = this.runKubectl(args, 15000);

        const resourceData = JSON.parse(output);

        // Check based on resource type
        if (resource === 'pod') {
          const phase = resourceData.status?.phase?.toLowerCase();
          const ready = resourceData.status?.conditions?.find(
            c => c.type === 'Ready' && c.status === 'True'
          );

          if (phase === 'running' && ready) {
            logger.info(`[VERIFICATION] ✅ Fix verified: ${resource}/${name} is running and ready`);
            return { verified: true, reason: 'Pod is running and ready' };
          }

          if (phase === 'failed' || phase === 'crashloopbackoff') {
            logger.error(`[VERIFICATION] ❌ Verification failed: ${resource}/${name} is in ${phase} state`);
            return {
              verified: false,
              reason: `Pod is in ${phase} state`,
              retryRecommended: true,
              alternativeOptions: [
                { id: 'retry', name: 'Retry same fix', description: 'Attempt the remediation again' },
                { id: 'escalate', name: 'Escalate to manual', description: 'Requires manual SRE intervention' },
                { id: 'rollback', name: 'Rollback deployment', description: 'Roll back to previous version' },
              ],
            };
          }
        } else if (resource === 'deployment') {
          const available = resourceData.status?.availableReplicas || 0;
          const desired = resourceData.status?.replicas || 0;

          if (available >= desired && desired > 0) {
            logger.info(`[VERIFICATION] ✅ Fix verified: Deployment ${name} has ${available}/${desired} replicas available`);
            return { verified: true, reason: `Deployment has ${available}/${desired} replicas available` };
          }
        }

        // Wait before next check
        await this.sleep(checkInterval);
      } catch (error) {
        // Resource might not exist yet (being created)
        if (error.stderr?.includes('NotFound')) {
          if (resource === 'pod' && type === 'DELETE') {
            const replacement = this.findReplacementPod(name, namespace);
            if (replacement.verified) {
              logger.info(`[VERIFICATION] ✅ Fix verified: Replacement pod ready for ${name}`);
              return replacement;
            }
          }
          await this.sleep(checkInterval);
          continue;
        }
        logger.error(`[VERIFICATION] ❌ Verification error: ${error.message}`);
        return {
          verified: false,
          reason: `Verification error: ${error.message}`,
          retryRecommended: true,
          alternativeOptions: [
            { id: 'retry', name: 'Retry same fix', description: 'Attempt the remediation again' },
            { id: 'escalate', name: 'Escalate to manual', description: 'Requires manual SRE intervention' },
          ],
        };
      }
    }

    logger.error(`[VERIFICATION] ❌ Verification timeout: ${resource}/${name} did not become ready within ${maxWaitTime}ms`);
    return {
      verified: false,
      reason: 'Verification timeout - resource did not become ready in time',
      retryRecommended: true,
      alternativeOptions: [
        { id: 'retry', name: 'Retry same fix', description: 'Attempt the remediation again' },
        { id: 'escalate', name: 'Escalate to manual', description: 'Requires manual SRE intervention' },
        { id: 'scale_up', name: 'Scale up deployment', description: 'Increase replica count to force new pods' },
      ],
    };
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * For pod delete actions, verify that a new replacement pod with matching workload prefix becomes ready.
   */
  findReplacementPod(originalPodName, namespace) {
    const prefix = this.getPodWorkloadPrefix(originalPodName);
    if (!prefix) {
      return { verified: false, reason: 'Replacement pod prefix could not be inferred' };
    }

    const args = [
      'get',
      'pods',
      '-n',
      namespace || 'default',
      '-o',
      'jsonpath={range .items[*]}{.metadata.name}{"|"}{.status.phase}{"|"}{range .status.conditions[*]}{.type}{"="}{.status}{","}{end}{"\\n"}{end}',
    ];

    const output = this.runKubectl(args, 15000);
    const lines = (output || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
      const [name, phase, conds = ''] = line.split('|');
      if (!name || name === originalPodName || !name.startsWith(prefix)) {
        continue;
      }
      const isRunning = (phase || '').toLowerCase() === 'running';
      const isReady = conds.includes('Ready=True');
      if (isRunning && isReady) {
        return {
          verified: true,
          reason: `Replacement pod ready: ${name}`,
        };
      }
    }

    return {
      verified: false,
      reason: `No ready replacement pod found for prefix ${prefix}`,
    };
  }

  getPodWorkloadPrefix(podName) {
    const parts = (podName || '').split('-');
    if (parts.length >= 3 && /^[a-z0-9]+$/i.test(parts[parts.length - 1])) {
      return parts.slice(0, -2).join('-');
    }
    if (parts.length >= 2) {
      return parts.slice(0, -1).join('-');
    }
    return podName || '';
  }

  /**
   * Validate strategy
   */
  validateStrategy(strategy) {
    if (!strategy || !strategy.type) return false;
    if (strategy.type !== 'runbook_steps' && !this.strategies.includes(strategy.type)) return false;
    if (!strategy.target) return false;
    if (strategy.namespace && this.protectedNamespaces.has(String(strategy.namespace).toLowerCase())) {
      logger.warn(`Blocked unsafe fix in protected namespace: ${strategy.namespace}`);
      return false;
    }
    return true;
  }

  /**
   * Get namespace for a resource
   */
  getNamespace(resourceName, clusterState) {
    const pods = clusterState.pods || [];
    const normalizedName = this.normalizeResourceName(resourceName);
    const pod = pods.find(p => this.normalizeResourceName(p.name) === normalizedName);
    return pod?.namespace || 'default';
  }

  /**
   * Get deployment name from pod name
   */
  getDeploymentName(podName, clusterState) {
    // Try to extract deployment from pod name
    // e.g., "api-server-7d9f4b8c5-x2z9a" → "api-server"
    const normalizedName = this.normalizeResourceName(podName);
    const match = normalizedName.match(/^(.+)-[a-z0-9]+-[a-z0-9]{5}$/);
    if (match) return match[1];

    // Fallback: use labels
    const pods = clusterState.pods || [];
    const pod = pods.find(p => this.normalizeResourceName(p.name) === normalizedName);
    return pod?.labels?.app || pod?.labels?.['app.kubernetes.io/name'] || podName;
  }

  /**
   * Normalize workload names from display labels.
   */
  normalizeResourceName(name) {
    return String(name || '').replace(/\s*\(deployment\)\s*$/i, '').trim();
  }

  /**
   * Calculate new replica count
   */
  calculateReplicas(deploymentName, clusterState, increment = 1) {
    const current = this.getCurrentReplicas(deploymentName, clusterState);
    return (current || 1) + increment;
  }

  /**
   * Get current replica count
   */
  getCurrentReplicas(deploymentName, clusterState) {
    // Count pods belonging to this deployment
    const pods = clusterState.pods || [];
    const deploymentPods = pods.filter(p => {
      const name = this.getDeploymentName(p.name, clusterState);
      return name === deploymentName;
    });
    return deploymentPods.length;
  }

  /**
   * Set dry run mode
   */
  setDryRun(enabled) {
    this.dryRun = enabled;
    logger.info(`Dry run mode: ${enabled ? 'ON' : 'OFF'}`);
  }

  /**
   * Set verification mode
   */
  setVerifyFixes(enabled) {
    this.verifyFixes = enabled;
    logger.info(`Fix verification: ${enabled ? 'ON' : 'OFF'}`);
  }

  /**
   * Get current execution mode info
   */
  getExecutionMode() {
    return {
      dryRun: this.dryRun,
      verifyFixes: this.verifyFixes,
      timeoutMs: this.timeoutMs,
      verifyTimeoutMs: this.verifyTimeoutMs,
    };
  }
}

// Export singleton
module.exports = new ExecutionerAgent();
