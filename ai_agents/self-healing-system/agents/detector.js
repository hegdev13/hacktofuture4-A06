/**
 * Detector Agent
 * Confirms and categorizes issues detected by the Observer
 * Acts as a bridge between Observer and RCA
 */

const config = require('../config');
const logger = require('../utils/logger');

class DetectorAgent {
  constructor() {
    this.issueHistory = new Map();
    this.confidenceThreshold = 70;
    this.duplicateWindowMs = 300000; // 5 minutes
  }

  /**
   * Detect and categorize issues from Observer analysis
   */
  async detectIssues(observerAnalysis, clusterState) {
    logger.timelineEvent('analysis', 'Detector: Confirming and categorizing detected issues');

    const rawIssues = observerAnalysis.issues || [];

    if (rawIssues.length === 0) {
      return {
        hasIssues: false,
        confirmedIssues: [],
        categorizedIssues: {},
        summary: 'No issues detected',
        timestamp: new Date().toISOString(),
      };
    }

    // Confirm issues (filter out false positives)
    const confirmedIssues = await this.confirmIssues(rawIssues, clusterState);

    // Categorize issues by type and severity
    const categorizedIssues = this.categorizeIssues(confirmedIssues);

    // Build failure groups (related issues)
    const failureGroups = this.buildFailureGroups(confirmedIssues, clusterState);

    // Calculate detection confidence
    const confidence = this.calculateDetectionConfidence(confirmedIssues, clusterState);

    // Check for patterns
    const patterns = this.detectPatterns(confirmedIssues);

    logger.timelineEvent(
      confirmedIssues.length > 0 ? 'issue' : 'success',
      `Detector: ${confirmedIssues.length} issue(s) confirmed out of ${rawIssues.length} detected`,
      { confirmed: confirmedIssues.length, raw: rawIssues.length, confidence }
    );

    return {
      hasIssues: confirmedIssues.length > 0,
      confirmedIssues,
      categorizedIssues,
      failureGroups,
      patterns,
      confidence,
      summary: this.generateSummary(confirmedIssues, categorizedIssues),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Confirm issues by filtering out false positives
   */
  async confirmIssues(rawIssues, clusterState) {
    const confirmed = [];

    for (const issue of rawIssues) {
      // Skip duplicates
      if (this.isDuplicate(issue)) {
        logger.debug(`Skipping duplicate issue: ${issue.target}`);
        continue;
      }

      // Confirm the issue still exists (re-check cluster state)
      const isStillValid = await this.confirmIssueValidity(issue, clusterState);
      if (!isStillValid) {
        logger.debug(`Issue no longer valid: ${issue.target}`);
        continue;
      }

      // Check for flapping (intermittent issues)
      const isFlapping = this.checkFlapping(issue);

      // Enhance issue with detection metadata
      const confirmedIssue = {
        ...issue,
        confirmed: true,
        confirmationTime: new Date().toISOString(),
        isFlapping,
        flappingCount: this.getFlappingCount(issue),
        confidence: this.calculateIssueConfidence(issue),
        detectionId: this.generateDetectionId(issue),
      };

      // Record in history
      this.recordIssue(confirmedIssue);
      confirmed.push(confirmedIssue);
    }

    return confirmed;
  }

  /**
   * Confirm issue is still valid by re-checking cluster state
   */
  async confirmIssueValidity(issue, clusterState) {
    const target = issue.target || issue.pod || issue.node;

    // Find the resource in current cluster state
    const pods = clusterState.pods || [];
    const nodes = clusterState.nodes || [];

     const issueType = issue.type || '';

     // Handle deployment issues separately
     if (issueType.includes('deployment')) {
       const deployments = clusterState.deployments || [];
       const deployment = deployments.find(d => d.name === target);

       if (!deployment) {
         // Deployment not found, issue resolved
         return false;
       }

       // Re-validate deployment issues
       switch (issueType) {
         case 'deployment_scaled_down':
           const desired = deployment.desiredReplicas || deployment.replicas || 0;
           const ready = deployment.readyReplicas || 0;
           return desired === 0 && ready === 0;

         case 'deployment_not_ready':
           const desiredReps = deployment.desiredReplicas || deployment.replicas || 0;
           const readyReps = deployment.readyReplicas || 0;
           return desiredReps > readyReps;

         case 'missing_deployment':
           return true;

         default:
           return true;
       }
     }

     const pod = pods.find(p => p.name === target);
     const node = nodes.find(n => n.name === target);

     const resource = pod || node;

     if (!resource) {
       // Resource might have been deleted, consider issue resolved
       return false;
     }

    // Re-validate specific issue types
    switch (issue.type) {
      case 'high_cpu':
      case 'elevated_cpu':
        return (resource.cpu || 0) > config.severity.thresholds.cpu.high;

      case 'high_memory':
      case 'elevated_memory':
        return (resource.memory || 0) > config.severity.thresholds.memory.high;

      case 'crash_loop':
        const phase = (resource.status || resource.phase || '').toLowerCase();
        return phase.includes('crash') || phase.includes('backoff');

      case 'not_ready':
        return resource.ready === false;

      case 'pod_failure':
        return (resource.status || '').toLowerCase() === 'failed';

      case 'excessive_restarts':
      case 'frequent_restarts':
        return (resource.restarts || 0) >= config.severity.thresholds.restarts.warning;

      default:
        // For other issues, assume they're valid
        return true;
    }
  }

  /**
   * Categorize issues by type and severity
   */
  categorizeIssues(issues) {
    const categories = {
      bySeverity: { high: [], medium: [], low: [] },
      byType: {},
      byResource: {},
      byNamespace: {},
    };

    for (const issue of issues) {
      // By severity
      const severity = issue.severity || 'low';
      categories.bySeverity[severity].push(issue);

      // By type
      const type = issue.type || 'unknown';
      if (!categories.byType[type]) categories.byType[type] = [];
      categories.byType[type].push(issue);

      // By resource
      const resource = issue.target || issue.pod || issue.node || 'unknown';
      if (!categories.byResource[resource]) categories.byResource[resource] = [];
      categories.byResource[resource].push(issue);

      // By namespace
      const namespace = issue.namespace || 'default';
      if (!categories.byNamespace[namespace]) categories.byNamespace[namespace] = [];
      categories.byNamespace[namespace].push(issue);
    }

    return categories;
  }

  /**
   * Build groups of related failures
   */
  buildFailureGroups(issues, clusterState) {
    const groups = [];
    const processed = new Set();

    // Group by dependency chains
    const dependencyGroups = this.groupByDependencies(issues, clusterState);
    groups.push(...dependencyGroups);

    // Group by namespace
    const namespaceGroups = this.groupByNamespace(issues);
    groups.push(...namespaceGroups);

    // Group by similar symptoms
    const symptomGroups = this.groupBySymptoms(issues);
    groups.push(...symptomGroups);

    return groups;
  }

  /**
   * Group issues by their dependencies
   */
  groupByDependencies(issues, clusterState) {
    const groups = [];
    const pods = clusterState.pods || [];

    // Build dependency map
    const dependencyMap = new Map();
    for (const pod of pods) {
      const deps = pod.dependencies || [];
      dependencyMap.set(pod.name, deps.map(d => d.target || d.resolvedTo).filter(Boolean));
    }

    // Find root causes (issues with no failed dependencies)
    const failedResources = new Set(issues.map(i => i.target || i.pod || i.node));

    for (const issue of issues) {
      const target = issue.target || issue.pod || issue.node;
      const deps = dependencyMap.get(target) || [];

      // Check if any dependency is also failed
      const hasFailedDependency = deps.some(dep => failedResources.has(dep));

      if (!hasFailedDependency) {
        // This might be a root cause
        const group = {
          type: 'dependency-chain',
          rootCause: issue,
          cascadingIssues: issues.filter(i => {
            const iTarget = i.target || i.pod || i.node;
            const iDeps = dependencyMap.get(iTarget) || [];
            return iDeps.includes(target);
          }),
          confidence: issue.confidence || 80,
        };
        groups.push(group);
      }
    }

    return groups;
  }

  /**
   * Group issues by namespace
   */
  groupByNamespace(issues) {
    const byNamespace = {};

    for (const issue of issues) {
      const ns = issue.namespace || 'default';
      if (!byNamespace[ns]) byNamespace[ns] = [];
      byNamespace[ns].push(issue);
    }

    return Object.entries(byNamespace)
      .filter(([_, issues]) => issues.length > 1)
      .map(([namespace, issues]) => ({
        type: 'namespace',
        namespace,
        issues,
        severity: this.calculateGroupSeverity(issues),
      }));
  }

  /**
   * Group issues by similar symptoms
   */
  groupBySymptoms(issues) {
    const symptomMap = new Map();

    for (const issue of issues) {
      const symptomKey = this.extractSymptomKey(issue);
      if (!symptomMap.has(symptomKey)) {
        symptomMap.set(symptomKey, []);
      }
      symptomMap.get(symptomKey).push(issue);
    }

    const groups = [];
    for (const [symptom, issues] of symptomMap) {
      if (issues.length > 1) {
        groups.push({
          type: 'symptom',
          symptom,
          issues,
          pattern: this.identifySymptomPattern(issues),
        });
      }
    }

    return groups;
  }

  /**
   * Extract symptom key from issue
   */
  extractSymptomKey(issue) {
    const parts = [issue.type];

    if (issue.metric) parts.push(issue.metric);
    if (issue.problem) {
      // Extract key phrases
      const problem = issue.problem.toLowerCase();
      if (problem.includes('cpu')) parts.push('cpu');
      if (problem.includes('memory')) parts.push('memory');
      if (problem.includes('restart')) parts.push('restart');
      if (problem.includes('connection')) parts.push('connection');
    }

    return parts.join('-');
  }

  /**
   * Identify symptom pattern
   */
  identifySymptomPattern(issues) {
    const types = issues.map(i => i.type);
    const uniqueTypes = [...new Set(types)];

    if (uniqueTypes.length === 1) {
      return `Uniform ${uniqueTypes[0]} affecting ${issues.length} resources`;
    }

    return `Mixed symptoms (${uniqueTypes.join(', ')}) affecting ${issues.length} resources`;
  }

  /**
   * Detect patterns in issues
   */
  detectPatterns(issues) {
    const patterns = [];

    // Check for cascading failures
    const cascadingCount = issues.filter(i => i.type === 'cascading_failure').length;
    if (cascadingCount > 0) {
      patterns.push({
        type: 'cascading',
        description: `${cascadingCount} cascading failure(s) detected`,
        severity: 'high',
      });
    }

    // Check for resource exhaustion
    const resourceIssues = issues.filter(i =>
      i.type?.includes('cpu') || i.type?.includes('memory')
    );
    if (resourceIssues.length > 2) {
      patterns.push({
        type: 'resource-exhaustion',
        description: `Resource exhaustion pattern: ${resourceIssues.length} pods affected`,
        severity: 'high',
      });
    }

    // Check for flapping
    const flappingIssues = issues.filter(i => i.isFlapping);
    if (flappingIssues.length > 0) {
      patterns.push({
        type: 'flapping',
        description: `${flappingIssues.length} issue(s) showing flapping behavior`,
        severity: 'medium',
      });
    }

    return patterns;
  }

  /**
   * Check if issue is a duplicate (recently detected)
   */
  isDuplicate(issue) {
    const target = issue.target || issue.pod || issue.node;
    const history = this.issueHistory.get(target);

    if (!history) return false;

    const now = Date.now();
    const recent = history.filter(h => now - new Date(h.timestamp).getTime() < this.duplicateWindowMs);

    return recent.length > 0;
  }

  /**
   * Check if issue is flapping
   */
  checkFlapping(issue) {
    const target = issue.target || issue.pod || issue.node;
    const history = this.issueHistory.get(target) || [];

    if (history.length < 3) return false;

    // Count transitions in last hour
    const oneHourAgo = Date.now() - 3600000;
    const recentHistory = history.filter(h => new Date(h.timestamp).getTime() > oneHourAgo);

    return recentHistory.length >= 3;
  }

  /**
   * Get flapping count for an issue
   */
  getFlappingCount(issue) {
    const target = issue.target || issue.pod || issue.node;
    const history = this.issueHistory.get(target) || [];
    const oneHourAgo = Date.now() - 3600000;
    return history.filter(h => new Date(h.timestamp).getTime() > oneHourAgo).length;
  }

  /**
   * Calculate detection confidence
   */
  calculateDetectionConfidence(issues, clusterState) {
    if (issues.length === 0) return 100;

    const scores = issues.map(i => i.confidence || 50);
    const avgConfidence = scores.reduce((a, b) => a + b, 0) / scores.length;

    // Reduce confidence if many issues
    const volumePenalty = Math.min(20, issues.length * 2);

    return Math.max(0, avgConfidence - volumePenalty);
  }

  /**
   * Calculate confidence for a single issue
   */
  calculateIssueConfidence(issue) {
    let confidence = 70; // Base confidence

    // Higher confidence for clear error states
    if (issue.severity === 'high') confidence += 10;
    if (issue.metric && issue.value) confidence += 10;
    if (issue.details?.errorCount) confidence += 5;

    // Lower confidence for ambiguous issues
    if (issue.severity === 'low') confidence -= 10;
    if (issue.isFlapping) confidence -= 15;

    return Math.min(100, Math.max(0, confidence));
  }

  /**
   * Calculate group severity
   */
  calculateGroupSeverity(issues) {
    const hasHigh = issues.some(i => i.severity === 'high');
    const hasMedium = issues.some(i => i.severity === 'medium');

    if (hasHigh) return 'high';
    if (hasMedium) return 'medium';
    return 'low';
  }

  /**
   * Record issue in history
   */
  recordIssue(issue) {
    const target = issue.target || issue.pod || issue.node;

    if (!this.issueHistory.has(target)) {
      this.issueHistory.set(target, []);
    }

    this.issueHistory.get(target).push({
      timestamp: issue.confirmationTime,
      type: issue.type,
      severity: issue.severity,
    });

    // Cleanup old history
    this.cleanupHistory();
  }

  /**
   * Cleanup old history entries
   */
  cleanupHistory() {
    const oneDayAgo = Date.now() - 86400000;

    for (const [target, history] of this.issueHistory) {
      const filtered = history.filter(h => new Date(h.timestamp).getTime() > oneDayAgo);
      if (filtered.length === 0) {
        this.issueHistory.delete(target);
      } else {
        this.issueHistory.set(target, filtered);
      }
    }
  }

  /**
   * Generate detection summary
   */
  generateSummary(confirmedIssues, categorizedIssues) {
    const counts = {
      high: categorizedIssues.bySeverity?.high?.length || 0,
      medium: categorizedIssues.bySeverity?.medium?.length || 0,
      low: categorizedIssues.bySeverity?.low?.length || 0,
    };

    return `${confirmedIssues.length} confirmed: ${counts.high} high, ${counts.medium} medium, ${counts.low} low severity`;
  }

  /**
   * Generate unique detection ID
   */
  generateDetectionId(issue) {
    const target = issue.target || issue.pod || issue.node || 'unknown';
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${target}-${timestamp}-${random}`;
  }

  /**
   * Get detection history for a resource
   */
  getHistory(target) {
    return this.issueHistory.get(target) || [];
  }

  /**
   * Clear detection history
   */
  clearHistory() {
    this.issueHistory.clear();
    logger.info('Detector history cleared');
  }

  /**
   * Get detector statistics
   */
  getStats() {
    let totalIssues = 0;
    for (const history of this.issueHistory.values()) {
      totalIssues += history.length;
    }

    return {
      totalTrackedResources: this.issueHistory.size,
      totalIssueOccurrences: totalIssues,
      duplicateWindowMs: this.duplicateWindowMs,
    };
  }
}

// Export singleton
module.exports = new DetectorAgent();
