/**
 * Convert metrics API data to dependency graph format
 */

export interface Pod {
  id: string;
  name: string;
  status: "running" | "failed" | "pending";
  message?: string;
  dependsOn?: string[];
}

export interface PodDependencyMap {
  [podName: string]: string[];
}

// Mock dependency map - represents real Kubernetes pod relationships
const DEFAULT_DEPENDENCIES: PodDependencyMap = {
  "api-server": [],
  "database-primary": [],
  "cache-redis": ["database-primary"],
  "worker-1": ["cache-redis", "database-primary"],
  "worker-2": ["cache-redis", "database-primary"],
  "web-frontend": ["api-server", "worker-1"],
  "monitoring-agent": ["api-server"],
  "log-aggregator": ["database-primary"],
};

export function convertMetricsToPods(
  metricsData: any,
  dependencyMap: PodDependencyMap = DEFAULT_DEPENDENCIES
): Pod[] {
  // Base pods from metrics
  const basePods = metricsData.pods || [];

  // Map metrics pods to our format
  const pods: Pod[] = basePods.map((pod: any) => ({
    id: pod.name,
    name: pod.name,
    status: pod.status === "Running" ? "running" : pod.status === "Failed" ? "failed" : "pending",
    message: pod.issues?.[0] || undefined,
    dependsOn: dependencyMap[pod.name] || [],
  }));

  // Add missing pods from dependency map for visualization
  Object.keys(dependencyMap).forEach((podName) => {
    if (!pods.find((p) => p.id === podName)) {
      pods.push({
        id: podName,
        name: podName,
        status: "running", // assume running if not in metrics
        dependsOn: dependencyMap[podName],
      });
    }
  });

  return pods;
}

export function identifyRootCause(pods: Pod[]): Pod[] {
  const failedPods = pods.filter((p) => p.status === "failed");
  const rootCausePods: Pod[] = [];

  failedPods.forEach((pod) => {
    if (pod.dependsOn && pod.dependsOn.length > 0) {
      pod.dependsOn.forEach((depId) => {
        const depPod = pods.find((p) => p.id === depId);
        if (depPod?.status === "failed" && !rootCausePods.includes(depPod)) {
          rootCausePods.push(depPod);
        }
      });
    }
  });

  return rootCausePods;
}

export function generateFixRecommendations(rootCausePods: Pod[]): string[] {
  if (rootCausePods.length === 0) return [];

  const recommendations: string[] = [];

  rootCausePods.forEach((pod) => {
    if (pod.name.includes("database")) {
      recommendations.push(`Check database: ${pod.name} - verify disk space and connections`);
    } else if (pod.name.includes("cache")) {
      recommendations.push(`Restart cache service: ${pod.name} - clear memory if needed`);
    } else if (pod.name.includes("worker")) {
      recommendations.push(`Check worker logs: ${pod.name} - inspect for task errors`);
    } else {
      recommendations.push(`Investigate: ${pod.name} - check resource usage and logs`);
    }
  });

  return recommendations;
}
