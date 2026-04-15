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
    const failureChain = rcaOutput.failureChain;

    // First issue in chain gives context
    const primaryIssue = failureChain[0] || '';
    const primaryReason = rcaOutput.chainDetails?.[0]?.health?.reason || '';

    // Strategy selection logic
    let strategy = {
      type: 'restart_pod',
      target: rootCause,
      namespace: 'default',
      priority: 1,
    };

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
    if (recommendation && recommendation.confidence >= config.memory.minConfidenceForLearning) {
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
    const action = {
      type: 'DELETE',
      resource: 'pod',
      name: podName,
      namespace,
      message: `Restarting pod ${namespace}/${podName}`,
    };

    const result = this.executeK8sAction(action);
    return { ...result, action };
  }

  /**
   * Restart a deployment (rollout restart)
   */
  restartDeployment(deploymentName, namespace) {
    const action = {
      type: 'RESTART',
      resource: 'deployment',
      name: deploymentName,
      namespace,
      message: `Rolling out restart for deployment ${namespace}/${deploymentName}`,
    };

    const result = this.executeK8sAction(action);
    return { ...result, action };
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
        args = ['delete', resource, name, ...ns, '--grace-period=30', '--force=false'];
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
   * Validate strategy
   */
  validateStrategy(strategy) {
    if (!strategy || !strategy.type) return false;
    if (!this.strategies.includes(strategy.type)) return false;
    if (!strategy.target) return false;
    return true;
  }

  /**
   * Get namespace for a resource
   */
  getNamespace(resourceName, clusterState) {
    const pods = clusterState.pods || [];
    const pod = pods.find(p => p.name === resourceName);
    return pod?.namespace || 'default';
  }

  /**
   * Get deployment name from pod name
   */
  getDeploymentName(podName, clusterState) {
    // Try to extract deployment from pod name
    // e.g., "api-server-7d9f4b8c5-x2z9a" → "api-server"
    const match = podName.match(/^(.+)-[a-z0-9]+-[a-z0-9]{5}$/);
    if (match) return match[1];

    // Fallback: use labels
    const pods = clusterState.pods || [];
    const pod = pods.find(p => p.name === podName);
    return pod?.labels?.app || pod?.labels?.['app.kubernetes.io/name'] || podName;
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
