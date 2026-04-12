/**
 * Root Cause Analysis Agent
 * Analyzes real-time cluster metrics to identify root cause of failures
 * and trace cascading effects through dependencies
 */

// Dependency map - represents real Kubernetes pod relationships
const POD_DEPENDENCIES = {
  'api-server': ['cache-redis', 'database-primary'],
  'database-primary': [],
  'cache-redis': ['database-primary'],
  'worker-1': ['cache-redis', 'database-primary'],
  'worker-2': ['cache-redis', 'database-primary'],
  'web-frontend': ['api-server', 'worker-1'],
  'monitoring-agent': ['api-server'],
  'log-aggregator': ['database-primary'],
};

/**
 * Find pods that failed first (root causes)
 * A pod is a root cause if:
 * 1. It's failed/pending AND
 * 2. It has no failed dependencies (it didn't fail because of another pod)
 */
function findRootCausePods(pods) {
  const failedPods = pods.filter(p => p.status !== 'Running');
  
  const rootCauses = failedPods.filter(failedPod => {
    // Get dependencies of this pod
    const dependencies = POD_DEPENDENCIES[failedPod.name] || [];
    
    // Check if any dependency is also failed
    const hasFaileudDependency = dependencies.some(depName => {
      const depPod = pods.find(p => p.name === depName);
      return depPod && depPod.status !== 'Running';
    });
    
    // If no failed dependencies, this pod is a root cause
    return !hasFaileudDependency;
  });
  
  return rootCauses;
}

/**
 * Find all pods affected by a failed pod (cascading effects)
 */
function findAffectedPods(rootCausePods, allPods) {
  const affected = new Set();
  const toCheck = [...rootCausePods];
  
  while (toCheck.length > 0) {
    const currentPod = toCheck.pop();
    
    // Find all pods that depend on current pod
    Object.entries(POD_DEPENDENCIES).forEach(([podName, deps]) => {
      if (deps.includes(currentPod.name)) {
        const pod = allPods.find(p => p.name === podName);
        if (pod && pod.status !== 'Running' && !affected.has(pod.name)) {
          affected.add(pod.name);
          toCheck.push(pod);
        }
      }
    });
  }
  
  return Array.from(affected);
}

/**
 * Trace the dependency chain from root cause to affected pods
 */
function traceDependencyChain(rootCausePod, allPods) {
  const chain = {
    rootCause: rootCausePod.name,
    rootCauseStatus: rootCausePod.status,
    affectedChain: []
  };
  
  const affected = [];
  const toCheck = [rootCausePod];
  const visited = new Set();
  
  while (toCheck.length > 0) {
    const currentPod = toCheck.shift();
    if (visited.has(currentPod.name)) continue;
    visited.add(currentPod.name);
    
    // Find dependents
    Object.entries(POD_DEPENDENCIES).forEach(([podName, deps]) => {
      if (deps.includes(currentPod.name)) {
        const dependentPod = allPods.find(p => p.name === podName);
        if (dependentPod && dependentPod.status !== 'Running') {
          affected.push({
            name: dependentPod.name,
            status: dependentPod.status,
            failureReason: `Depends on ${currentPod.name}`
          });
          toCheck.push(dependentPod);
        }
      }
    });
  }
  
  chain.affectedChain = affected;
  return chain;
}

/**
 * Generate remediation actions based on root cause
 */
function generateRemediations(rootCausePods, affectedCount) {
  const remediations = [];
  
  rootCausePods.forEach(pod => {
    if (pod.name.includes('database')) {
      remediations.push({
        priority: 'critical',
        action: `Restart ${pod.name}`,
        reason: 'Database pod is the root cause',
        command: `kubectl restart pod ${pod.name}`,
        impact: `Will recover ${affectedCount} affected pods`
      });
      remediations.push({
        priority: 'high',
        action: `Check disk space and connections`,
        reason: 'Database crashes usually indicate resource constraints',
        command: `kubectl exec ${pod.name} -- df -h && ss -an | wc -l`
      });
    } else if (pod.name.includes('cache')) {
      remediations.push({
        priority: 'critical',
        action: `Restart ${pod.name}`,
        reason: 'Cache pod is the root cause',
        command: `kubectl restart pod ${pod.name}`,
        impact: `Will recover ${affectedCount} affected pods`
      });
      remediations.push({
        priority: 'high',
        action: `Clear memory cache if needed`,
        reason: 'Cache pods crash due to memory issues',
        command: `kubectl exec ${pod.name} -- redis-cli FLUSHALL`
      });
    } else if (pod.name.includes('api')) {
      remediations.push({
        priority: 'high',
        action: `Restart ${pod.name}`,
        reason: 'API server is affecting downstream services',
        command: `kubectl restart pod ${pod.name}`
      });
    } else {
      remediations.push({
        priority: 'high',
        action: `Investigate ${pod.name}`,
        reason: 'Pod failed with unknown cause',
        command: `kubectl logs ${pod.name} -n default --tail=50`
      });
    }
  });
  
  return remediations;
}

/**
 * Main RCA Analysis function
 */
function analyzeMetrics(metricsData) {
  const pods = metricsData.pods || [];
  
  // Find root causes
  const rootCausePods = findRootCausePods(pods);
  
  if (rootCausePods.length === 0) {
    return {
      status: 'healthy',
      rootCauses: [],
      affectedPods: [],
      dependencyChains: [],
      remediations: [],
      summary: 'All pods running normally'
    };
  }
  
  // Find all affected pods
  const affectedPods = findAffectedPods(rootCausePods, pods);
  
  // Trace dependency chains
  const dependencyChains = rootCausePods.map(rootCause => 
    traceDependencyChain(rootCause, pods)
  );
  
  // Generate remediations
  const remediations = generateRemediations(rootCausePods, affectedPods.length);
  
  // Calculate impact
  const impactedPodsCount = affectedPods.length + rootCausePods.length;
  const totalPods = pods.length;
  const healthPercent = Math.round(((totalPods - impactedPodsCount) / totalPods) * 100);
  
  return {
    status: impactedPodsCount > 2 ? 'critical' : 'degraded',
    rootCauses: rootCausePods.map(p => ({
      name: p.name,
      status: p.status,
      cpu: p.cpu,
      memory: p.memory
    })),
    affectedPods: affectedPods,
    impactedCount: impactedPodsCount,
    healthPercent: healthPercent,
    dependencyChains: dependencyChains,
    remediations: remediations,
    summary: `${rootCausePods.length} root cause(s) detected affecting ${affectedPods.length} pods (${healthPercent}% healthy)`
  };
}

/**
 * Build enriched pod data with RCA analysis
 */
function enrichPodsWithRCA(pods, rcaAnalysis) {
  return pods.map(pod => {
    const isRootCause = rcaAnalysis.rootCauses.some(r => r.name === pod.name);
    const isAffected = rcaAnalysis.affectedPods.includes(pod.name);
    
    let failureType = 'healthy';
    if (isRootCause) {
      failureType = 'root-cause';
    } else if (isAffected) {
      failureType = 'cascading';
    }
    
    // Find reason if affected
    let failureReason = null;
    if (isAffected) {
      const deps = POD_DEPENDENCIES[pod.name] || [];
      const failedDep = deps.find(depName => 
        rcaAnalysis.rootCauses.some(r => r.name === depName)
      );
      if (failedDep) {
        failureReason = `Depends on ${failedDep}`;
      }
    }
    
    return {
      ...pod,
      failureType,
      failureReason,
      dependencies: POD_DEPENDENCIES[pod.name] || []
    };
  });
}

module.exports = {
  analyzeMetrics,
  enrichPodsWithRCA,
  findRootCausePods,
  findAffectedPods,
  traceDependencyChain,
  generateRemediations,
  POD_DEPENDENCIES
};
