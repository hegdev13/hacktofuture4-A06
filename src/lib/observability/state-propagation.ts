/**
 * State Propagation Utility
 * Handles propagation of pod states through dependency graphs
 * 
 * Propagation Rules:
 * - Hard dependency FAILED → dependent FAILS
 * - Soft dependency FAILED → dependent DEGRADED
 * - Service only recovers when ALL dependencies HEALTHY
 */

export type PodStatus = "running" | "failed" | "pending";
export type FailureType = "healthy" | "root-cause" | "cascading";

export interface PodState {
  name: string;
  status: PodStatus;
  healthScore: number;
  restartCount: number;
  errorRate: number;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: "hard" | "soft"; // hard = critical, soft = graceful degradation
}

export interface PropagationResult {
  propagated: Map<string, PodState>;
  changes: Array<{
    pod: string;
    oldStatus: PodStatus;
    newStatus: PodStatus;
    reason: string;
  }>;
}

/**
 * Propagate pod state changes through dependency graph
 * 
 * @param pods - Map of pod names to their current states
 * @param dependencies - List of dependency edges
 * @param failedPods - Set of pods that have failed
 * @returns Updated pod states with propagation info
 */
export function propagateStates(
  pods: Map<string, PodState>,
  dependencies: DependencyEdge[],
  failedPods: Set<string>
): PropagationResult {
  const propagated = new Map(pods);
  const changes: PropagationResult["changes"] = [];

  // Keep propagating until no more changes
  let moreChanges = true;
  let iterations = 0;
  const maxIterations = 100; // Prevent infinite loops

  while (moreChanges && iterations < maxIterations) {
    moreChanges = false;
    iterations++;

    // Check each pod
    for (const [podName, podState] of propagated.entries()) {
      // Find dependencies for this pod
      const deps = dependencies.filter((d) => d.to === podName);

      if (deps.length === 0) {
        continue; // No dependencies, skip
      }

      // Determine new status based on dependencies
      let newStatus = podState.status;
      let reason = "";

      // Hard dependencies: if any failed, this pod fails
      const hardFailedDeps = deps
        .filter((d) => d.type === "hard" && propagated.get(d.from)?.status === "failed")
        .map((d) => d.from);

      if (hardFailedDeps.length > 0) {
        if (podState.status !== "failed") {
          newStatus = "failed";
          reason = `Hard dependency failure: ${hardFailedDeps[0]}`;
          moreChanges = true;
        }
      } else {
        // Soft dependencies: if any failed, this pod degrades
        const softFailedDeps = deps
          .filter((d) => d.type === "soft" && propagated.get(d.from)?.status === "failed")
          .map((d) => d.from);

        if (softFailedDeps.length > 0) {
          if (podState.status === "running") {
            newStatus = "pending"; // Degraded state
            reason = `Soft dependency failure: ${softFailedDeps[0]}`;
            moreChanges = true;
          }
        } else {
          // All dependencies healthy - can recover
          const allDepsHealthy = deps.every(
            (d) => propagated.get(d.from)?.status === "running"
          );

          if (allDepsHealthy && (podState.status === "pending" || podState.status === "failed")) {
            // Only recover if was previously failed/degraded
            if (failedPods.has(podName)) {
              // Don't auto-recover pods that had active failures
              // They need explicit recovery
              newStatus = "pending";
              reason = "All dependencies healthy, awaiting recovery signal";
            } else {
              newStatus = "running";
              reason = "All dependencies healthy, recovered";
              moreChanges = true;
            }
          }
        }
      }

      // Apply state change if different
      if (newStatus !== podState.status) {
        const oldStatus = podState.status;
        propagated.set(podName, {
          ...podState,
          status: newStatus,
        });
        changes.push({
          pod: podName,
          oldStatus,
          newStatus,
          reason,
        });
      }
    }
  }

  return {
    propagated,
    changes,
  };
}

/**
 * Build dependency edges from a dependency map
 * 
 * @param dependencyMap - Map of service name to list of dependencies
 * @returns List of dependency edges
 */
export function buildDependencyEdges(
  dependencyMap: Map<string, string[]>
): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  const criticalServices = new Set([
    "database",
    "db",
    "postgres",
    "mysql",
    "redis",
    "cache",
    "api",
    "backend",
  ]);

  for (const [service, deps] of dependencyMap.entries()) {
    for (const dep of deps) {
      // Determine if hard or soft dependency
      const type = criticalServices.has(dep.toLowerCase()) ? "hard" : "soft";

      edges.push({
        from: service,
        to: dep,
        type,
      });
    }
  }

  return edges;
}

/**
 * Identify failure type for a pod based on its dependencies
 */
export function identifyFailureType(
  podName: string,
  podStatus: PodStatus,
  rootCausePod: string | null,
  dependencies: DependencyEdge[]
): FailureType {
  if (podStatus === "running") {
    return "healthy";
  }

  if (podName === rootCausePod) {
    return "root-cause";
  }

  // Check if this pod's failure is cascading from a dependent
  const incomingDeps = dependencies.filter((d) => d.to === podName && d.from !== podName);
  const failedUpstream = incomingDeps.some((d) => d.from === rootCausePod);

  if (failedUpstream) {
    return "cascading";
  }

  return "healthy";
}

/**
 * Calculate health score based on state
 */
export function calculateHealthScore(state: PodState): number {
  let score = 100;

  // Status penalty
  if (state.status === "failed") {
    score -= 50;
  } else if (state.status === "pending") {
    score -= 25;
  }

  // Restart count penalty
  score -= Math.min(20, state.restartCount * 5);

  // Error rate penalty
  score -= Math.min(20, state.errorRate * 100);

  return Math.max(0, Math.min(100, score));
}

/**
 * Detect potential cascading failures
 */
export function detectCascadingFailures(
  podStates: Map<string, PodState>,
  dependencies: DependencyEdge[],
  failedPods: Set<string>
): Map<string, string[]> {
  const cascading = new Map<string, string[]>();

  for (const failedPod of failedPods) {
    const affectedPods = findAffectedPods(failedPod, dependencies, podStates);
    if (affectedPods.length > 0) {
      cascading.set(failedPod, affectedPods);
    }
  }

  return cascading;
}

/**
 * Find all pods affected by a failed pod
 */
export function findAffectedPods(
  failedPod: string,
  dependencies: DependencyEdge[],
  podStates: Map<string, PodState>
): string[] {
  const affected: string[] = [];
  const queue = [failedPod];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    // Find pods that depend on current
    const dependents = dependencies
      .filter((d) => d.from === current)
      .map((d) => d.to);

    for (const dependent of dependents) {
      const depState = podStates.get(dependent);
      if (depState && depState.status !== "running") {
        affected.push(dependent);
        queue.push(dependent);
      }
    }
  }

  return affected;
}

/**
 * Validate dependency graph for cycles
 */
export function hasCycle(dependencies: DependencyEdge[]): boolean {
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function dfs(node: string): boolean {
    visited.add(node);
    recursionStack.add(node);

    const neighbors = dependencies
      .filter((d) => d.from === node)
      .map((d) => d.to);

    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) {
          return true;
        }
      } else if (recursionStack.has(neighbor)) {
        return true;
      }
    }

    recursionStack.delete(node);
    return false;
  }

  // Find all nodes
  const nodes = new Set<string>();
  for (const dep of dependencies) {
    nodes.add(dep.from);
    nodes.add(dep.to);
  }

  // Check each node
  for (const node of nodes) {
    if (!visited.has(node)) {
      if (dfs(node)) {
        return true;
      }
    }
  }

  return false;
}
