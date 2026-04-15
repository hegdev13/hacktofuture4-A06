import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // Fetch real metrics from the metrics server
    const metricsResponse = await fetch('http://localhost:5555/api/metrics', {
      cache: 'no-store'
    });
    
    if (!metricsResponse.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch metrics' },
        { status: 500 }
      );
    }
    
    const metricsData = await metricsResponse.json();
    
    // Import and run RCA analysis
    // Since this is server-side, we'll do a basic analysis here
    const rcaAnalysis = performRCA(metricsData);
    
    return NextResponse.json(rcaAnalysis);
  } catch (error) {
    console.error('RCA Error:', error);
    return NextResponse.json(
      { error: 'RCA analysis failed' },
      { status: 500 }
    );
  }
}

/**
 * Perform RCA analysis on metrics
 */
function performRCA(metricsData: {
  pods?: Array<{
    name: string;
    namespace?: string;
    status: string;
    cpu?: number;
    memory?: number;
  }>;
}) {
  const pods = metricsData.pods || [];
  
  const POD_DEPENDENCIES: Record<string, string[]> = {
    'api-server': ['cache-redis', 'database-primary'],
    'database-primary': [],
    'cache-redis': ['database-primary'],
    'worker-1': ['cache-redis', 'database-primary'],
    'worker-2': ['cache-redis', 'database-primary'],
    'web-frontend': ['api-server', 'worker-1'],
    'monitoring-agent': ['api-server'],
    'log-aggregator': ['database-primary'],
  };

  // Find root causes - pods that failed without a failed dependency
  const failedPods = pods.filter(p => p.status !== 'Running');
  
  const rootCausePods = failedPods.filter(failedPod => {
    const dependencies = POD_DEPENDENCIES[failedPod.name] || [];
    const hasFailedDependency = dependencies.some(depName => {
      const depPod = pods.find(p => p.name === depName);
      return depPod && depPod.status !== 'Running';
    });
    return !hasFailedDependency;
  });

  // Find affected pods (failed due to root cause)
  const affectedPods = failedPods.filter(pod => {
    return !rootCausePods.some(rc => rc.name === pod.name);
  });

  // Enrich pods with RCA metadata
  const enrichedPods = pods.map(pod => {
    const isRootCause = rootCausePods.some(r => r.name === pod.name);
    const isAffected = affectedPods.some(a => a.name === pod.name);
    
    let failureType = 'healthy';
    let failureReason = null;

    if (isRootCause) {
      failureType = 'root-cause';
      failureReason = 'Original failure point';
    } else if (isAffected) {
      failureType = 'cascading';
      const deps = POD_DEPENDENCIES[pod.name] || [];
      const failedDep = deps.find(depName => 
        rootCausePods.some(rc => rc.name === depName)
      );
      if (failedDep) {
        failureReason = `Failed because ${failedDep} is down`;
      }
    }

    return {
      id: pod.name,
      name: pod.name,
      namespace: pod.namespace,
      status: pod.status === 'Running' ? 'running' : pod.status.includes('Failed') || pod.status === 'CrashLoopBackOff' ? 'failed' : 'pending',
      cpu: pod.cpu,
      memory: pod.memory,
      failureType,
      failureReason,
      dependencies: POD_DEPENDENCIES[pod.name] || [],
      dependents: Object.entries(POD_DEPENDENCIES)
        .filter(([_, deps]) => deps.includes(pod.name))
        .map(([name]) => name)
    };
  });

  // Generate remediations
  const remediations: Array<{
    priority: string;
    title: string;
    description: string;
    command: string;
    impact?: string;
  }> = [];
  rootCausePods.forEach(pod => {
    if (pod.name.includes('database')) {
      remediations.push({
        priority: 'critical',
        title: `Restart ${pod.name}`,
        description: 'Database pod is the root cause of cascading failures',
        command: `kubectl rollout restart deployment/$(kubectl get pod ${pod.name} -o jsonpath='{.metadata.ownerReferences[0].name}')`,
        impact: `Will recover ${affectedPods.length} affected pods`
      });
    } else if (pod.name.includes('cache')) {
      remediations.push({
        priority: 'critical',
        title: `Restart ${pod.name}`,
        description: 'Cache pod is the root cause - will cascade to dependent services',
        command: `kubectl rollout restart deployment/$(kubectl get pod ${pod.name} -o jsonpath='{.metadata.ownerReferences[0].name}')`,
        impact: `Will recover ${affectedPods.length} affected pods`
      });
    } else {
      remediations.push({
        priority: 'high',
        title: `Investigate ${pod.name}`,
        description: 'Pod failed - gather logs and metrics',
        command: `kubectl logs ${pod.name} -n default --tail=100 && kubectl describe pod ${pod.name}`,
      });
    }
  });

  const totalPods = pods.length;
  const healthyCount = pods.filter(p => p.status === 'Running').length;
  const healthPercent = Math.round((healthyCount / totalPods) * 100);

  return {
    timestamp: new Date().toISOString(),
    status: rootCausePods.length === 0 ? 'healthy' : rootCausePods.length > 1 ? 'critical' : 'degraded',
    healthPercent,
    totalPods,
    healthyPods: healthyCount,
    failedPods: failedPods.length,
    rootCausesCount: rootCausePods.length,
    affectedPodsCount: affectedPods.length,
    rootCauses: rootCausePods.map(p => ({
      name: p.name,
      status: p.status,
      message: `${p.name} is in ${p.status} state`
    })),
    pods: enrichedPods,
    remediations: remediations,
    summary: rootCausePods.length === 0 
      ? 'All systems operational'
      : `${rootCausePods.length} root cause(s) causing ${affectedPods.length} cascading failure(s) - ${healthPercent}% cluster health`
  };
}
