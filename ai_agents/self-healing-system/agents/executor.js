/**
 * Executioner Agent
 * Executes fixes based on RCA output with abstraction layer for K8s operations
 */

const { execSync } = require('child_process');
const config = require('../config');
const logger = require('../utils/logger');
const memory = require('./memory');
const geminiKnowledgeBase = require('../utils/geminiKnowledgeBase');

class ExecutionerAgent {
  constructor() {
    this.strategies = config.execution.strategies;
    this.dryRun = config.execution.dryRun;
    this.timeoutMs = config.execution.timeoutMs;
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
    const strategy = await this.determineStrategy(rcaOutput, recommendation, clusterState);

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
    const result = this.executeStrategy(strategy, rcaOutput, clusterState);

    // Store learning
    memory.storeLearning({
      issueType: rcaOutput.failureChain[0] || 'unknown',
      problemSignature: rcaOutput.failureChain.join('|'),
      fixType: strategy.type,
      target: strategy.target,
      success: result.status === 'success',
      beforeState: rcaOutput,
      afterState: result,
    });

    logger.timelineEvent(
      result.status === 'success' ? 'success' : 'error',
      `Fix execution ${result.status}`,
      { fixType: result.fixType, target: result.target }
    );

    return result;
  }

  /**
   * Determine the best fix strategy
   */
  async determineStrategy(rcaOutput, recommendation, clusterState) {
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

     // Deployment scaled down → scale up to 1 replica
     if (primaryReason.includes('deployment_scaled_down') || primaryIssue === 'deployment_scaled_down') {
       strategy = {
         type: 'scale_up',
         target: rootCause,
         namespace: this.getNamespace(rootCause, clusterState),
         replicas: 1,
         priority: 0,  // Highest priority
       };
     }
    // High restart count → restart
    if (primaryReason.includes('restart') || primaryIssue.includes('restart')) {
      strategy = {
        type: 'restart_pod',
        target: rootCause,
        namespace: this.getNamespace(rootCause, clusterState),
        priority: 1,
      };
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

    // Query Gemini knowledge base for contextual remediation guidance.
    const kbRecommendation = await geminiKnowledgeBase.getRemediationGuidance({
      rootCause,
      rootCauseType,
      failureChain,
      chainDetails: rcaOutput.chainDetails,
      affectedResources: rcaOutput.affectedResources,
    });

    if (
      kbRecommendation &&
      config.execution.strategies.includes(kbRecommendation.strategy) &&
      kbRecommendation.confidence >= config.knowledgeBase.minConfidence
    ) {
      strategy.type = kbRecommendation.strategy;
      strategy.target = kbRecommendation.target || strategy.target;
      logger.info(
        `Applying Gemini KB strategy: ${strategy.type} on ${strategy.target} (${kbRecommendation.confidence}%)`
      );
    }

    return strategy;
  }

  /**
   * Execute the chosen strategy
   */
  executeStrategy(strategy, rcaOutput, clusterState) {
    const startTime = Date.now();

    try {
      let result;

      switch (strategy.type) {
        case 'restart_pod':
          result = this.restartPod(strategy.target, strategy.namespace);
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
          result = this.restartDependencyFirst(strategy, rcaOutput, clusterState);
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

    return this.executeK8sAction(action);
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

    return this.executeK8sAction(action);
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

    return this.executeK8sAction(action);
  }

  /**
   * Restart dependency first, then original target
   */
  restartDependencyFirst(strategy, rcaOutput, clusterState) {
    // First restart dependency
    const depResult = this.restartPod(strategy.target, strategy.namespace);

    if (depResult.status !== 'success') {
      return {
        status: 'failed',
        message: `Failed to restart dependency ${strategy.target}: ${depResult.message}`,
        metadata: { phase: 'dependency', dependency: strategy.target },
      };
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

    return this.executeK8sAction(action);
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

    return this.executeK8sAction(action);
  }

  /**
   * Execute K8s action (abstraction layer)
   * Executes real kubectl commands to perform remediation
   */
  executeK8sAction(action) {
    // Log the action
    logger.info(`K8s Action: ${action.message || action.type}`);
    logger.debug('Action details', action);

    if (this.dryRun) {
      // In dry run mode, simulate success
      logger.info('[DRY RUN] Action would be executed:', action);
      return {
        status: 'success',
        message: `[DRY RUN] ${action.message || action.type} - Not actually executed`,
        metadata: { dryRun: true, action },
      };
    }

    // Execute real kubectl commands
    try {
      let command = '';

      switch (action.type) {
        case 'DELETE':
          // kubectl delete pod <name> -n <namespace>
          command = `kubectl delete pod ${action.name} -n ${action.namespace}`;
          break;

        case 'SCALE':
          // kubectl scale deployment <name> -n <namespace> --replicas=<count>
          command = `kubectl scale deployment/${action.name} -n ${action.namespace} --replicas=${action.replicas}`;
          break;

        case 'ROLLBACK':
          // kubectl rollout undo deployment/<name> -n <namespace>
          command = `kubectl rollout undo deployment/${action.name} -n ${action.namespace}`;
          break;

        case 'CORDON':
          // kubectl cordon <node>
          command = `kubectl cordon ${action.name}`;
          break;

        case 'DRAIN':
          // kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
          command = `kubectl drain ${action.name} --ignore-daemonsets --delete-emptydir-data`;
          break;

        default:
          throw new Error(`Unknown action type: ${action.type}`);
      }

      logger.info(`Executing kubectl command: ${command}`);

      // Execute the command
      const output = execSync(command, { 
        encoding: 'utf-8',
        timeout: this.timeoutMs,
      });

      logger.info(`Command executed successfully`);
      if (output) {
        logger.debug(`Command output: ${output}`);
      }

      return {
        status: 'success',
        message: `Successfully executed ${action.type} on ${action.resource} ${action.name}`,
        metadata: { action, output },
      };

    } catch (error) {
      const errorMsg = error.stderr ? error.stderr.toString() : error.message;
      logger.error(`K8s action failed: ${errorMsg}`);
      
      return {
        status: 'failed',
        message: `Failed to execute ${action.type}: ${errorMsg}`,
        error: error.stack,
      };
    }
  }

  /**
   * Simulate API call (for testing)
   */
  simulateAPICall(action) {
    // Simulate network latency
    const latency = Math.random() * 100 + 50;
    const start = Date.now();
    while (Date.now() - start < latency) {
      // Busy wait to simulate latency
    }

    // Randomly fail 5% of calls for realism
    if (Math.random() < 0.05) {
      throw new Error('Simulated API failure');
    }

    return { success: true };
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
}

// Export singleton
module.exports = new ExecutionerAgent();
