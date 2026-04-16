/**
 * Executioner Agent
 * Executes fixes based on RCA output with abstraction layer for K8s operations
 */

const config = require('../config');
const logger = require('../utils/logger');
const memory = require('./memory');
const { execFileSync } = require('child_process');

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

    // Execute the strategy
    let result = await this.executeStrategy(strategy, rcaOutput, clusterState);

    // Verify the fix if it succeeded and we're not in dry run
    if (result.status === 'success' && result.action && !this.dryRun && this.verifyFixes) {
      const verification = await this.verifyFix(result.action, clusterState);
      result.verification = verification;

      if (!verification.verified) {
        result.status = 'partial';
        result.message += ` (Verification failed: ${verification.reason})`;
      } else {
        result.message += ` (Verified: ${verification.reason})`;
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
      { fixType: result.fixType, target: result.target }
    );

    return result;
  }

  /**
   * Determine the best fix strategy
   */
  determineStrategy(rcaOutput, recommendation, clusterState) {
    const rootCause = rcaOutput.rootCause;
    const rootCauseType = rcaOutput.rootCauseType;
    const manualTargetKind = rcaOutput.manualTargetKind;
    const failureChain = rcaOutput.failureChain;

    // First issue in chain gives context
    const primaryIssue = failureChain[0] || '';
    const primaryReason = rcaOutput.chainDetails?.[0]?.health?.reason || '';

    // Strategy selection logic
    let strategy = {
      type: manualTargetKind === 'deployment' || rootCauseType === 'deployment' ? 'restart_deployment' : 'restart_pod',
      target: rootCause,
      namespace: this.getNamespace(rootCause, clusterState),
      priority: 1,
    };

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

  /**
   * Verify that a fix was applied successfully
   */
  async verifyFix(action, clusterState) {
    if (!this.verifyFixes) {
      return { verified: true, reason: 'Verification disabled' };
    }

    const { resource, name, namespace, type } = action;
    const startTime = Date.now();
    const checkInterval = 2000; // Check every 2 seconds
    const maxWaitTime = this.verifyTimeoutMs;

    logger.info(`Verifying fix for ${resource}/${name}...`);

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
            return { verified: true, reason: 'Pod is running and ready' };
          }

          if (phase === 'failed' || phase === 'crashloopbackoff') {
            return { verified: false, reason: `Pod is in ${phase} state` };
          }
        } else if (resource === 'deployment') {
          const available = resourceData.status?.availableReplicas || 0;
          const desired = resourceData.status?.replicas || 0;

          if (available >= desired && desired > 0) {
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
              return replacement;
            }
          }
          await this.sleep(checkInterval);
          continue;
        }
        return { verified: false, reason: `Verification error: ${error.message}` };
      }
    }

    return { verified: false, reason: 'Verification timeout - resource did not become ready in time' };
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
    if (!this.strategies.includes(strategy.type)) return false;
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
