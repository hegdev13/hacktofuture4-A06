import type { ClusterSnapshot } from "@/lib/kube/types";

type ServiceHealth = {
  service: string;
  cpu: number;
  memory: number;
  restarts: number;
  failureRatio: number;
  healthScore: number;
};

export type DependencyNode = {
  id: string;
  name: string;
  status: "running" | "failed" | "pending";
  failureType: "healthy" | "root-cause" | "cascading";
  failureReason?: string;
  dependsOn: string[];
  healthScore: number;
};

function serviceNameFromPod(podName: string) {
  const parts = podName.split("-");
  if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
  return podName;
}

function inferDependencies(services: string[]) {
  const deps = new Map<string, string[]>();

  for (const s of services) {
    const low = s.toLowerCase();
    if (low.includes("frontend")) {
      deps.set(s, services.filter((x) => /checkout|catalog|recommendation|cart|currency/i.test(x)));
    } else if (low.includes("checkout")) {
      deps.set(s, services.filter((x) => /cart|payment|shipping|email|catalog|currency/i.test(x)));
    } else if (low.includes("cart")) {
      deps.set(s, services.filter((x) => /redis|cache/i.test(x)));
    } else if (low.includes("recommend")) {
      deps.set(s, services.filter((x) => /catalog/i.test(x)));
    } else if (low.includes("worker")) {
      deps.set(s, services.filter((x) => /api|queue|redis|cache/i.test(x)));
    } else if (low.includes("api")) {
      deps.set(s, services.filter((x) => /db|postgres|mysql|redis|cache/i.test(x)));
    } else {
      deps.set(s, []);
    }
  }

  return deps;
}

function normalizeStatus(status: string): "running" | "failed" | "pending" {
  const s = status.toLowerCase();
  if (s.includes("running") || s === "ok") return "running";
  if (s.includes("pending") || s.includes("init")) return "pending";
  return "failed";
}

function average(values: number[]) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function calculateHealth(cpu: number, memory: number, restarts: number, failureRatio: number) {
  const cpuPenalty = Math.min(45, Math.max(0, cpu) * 40);
  const memoryPenalty = Math.min(25, Math.max(0, memory) / 1024 / 1024 / 512 * 25);
  const restartPenalty = Math.min(15, restarts * 3);
  const failurePenalty = Math.min(40, failureRatio * 40);
  const score = 100 - cpuPenalty - memoryPenalty - restartPenalty - failurePenalty;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function buildDependencyImpact(snapshot: ClusterSnapshot): {
  graphPods: DependencyNode[];
  root_cause: string;
  confidence: number;
  status: "healthy" | "degraded" | "critical";
  healthPercent: number;
  summary: string;
  remediations: Array<{
    priority: string;
    action: string;
    reason: string;
    command: string;
    impact?: string;
  }>;
} {
  const servicePods = new Map<string, typeof snapshot.pods>();
  for (const pod of snapshot.pods) {
    const service = serviceNameFromPod(pod.pod_name);
    const group = servicePods.get(service) ?? [];
    group.push(pod);
    servicePods.set(service, group);
  }

  const healthRows: ServiceHealth[] = [];
  for (const [service, pods] of servicePods.entries()) {
    const cpu = average(pods.map((p) => (typeof p.cpu_usage === "number" ? p.cpu_usage : 0)));
    const memory = average(pods.map((p) => (typeof p.memory_usage === "number" ? p.memory_usage : 0)));
    const restarts = average(pods.map((p) => p.restart_count ?? 0));
    const failed = pods.filter((p) => normalizeStatus(p.status) === "failed").length;
    const failureRatio = pods.length ? failed / pods.length : 0;

    healthRows.push({
      service,
      cpu,
      memory,
      restarts,
      failureRatio,
      healthScore: calculateHealth(cpu, memory, restarts, failureRatio),
    });
  }

  const deps = inferDependencies([...servicePods.keys()]);
  const root = [...healthRows].sort((a, b) => a.healthScore - b.healthScore)[0];

  const impacted = new Set<string>();
  if (root) {
    const queue = [root.service];
    while (queue.length) {
      const current = queue.shift() as string;
      for (const [svc, svcDeps] of deps.entries()) {
        if (svcDeps.includes(current) && !impacted.has(svc)) {
          impacted.add(svc);
          queue.push(svc);
        }
      }
    }
  }

  const graphPods: DependencyNode[] = healthRows.map((h) => {
    const status: DependencyNode["status"] =
      h.healthScore >= 80 ? "running" : h.healthScore >= 55 ? "pending" : "failed";
    const isRoot = root?.service === h.service;
    const isCascading = impacted.has(h.service);

    return {
      id: h.service,
      name: h.service,
      status,
      dependsOn: deps.get(h.service) ?? [],
      healthScore: h.healthScore,
      failureType: isRoot ? "root-cause" : isCascading ? "cascading" : "healthy",
      failureReason: isRoot
        ? "Lowest service health score"
        : isCascading
          ? "Impacted by upstream dependency degradation"
          : undefined,
    };
  });

  const clusterHealth = healthRows.length
    ? Math.round(healthRows.reduce((sum, r) => sum + r.healthScore, 0) / healthRows.length)
    : 100;

  const status: "healthy" | "degraded" | "critical" =
    clusterHealth >= 80 ? "healthy" : clusterHealth >= 50 ? "degraded" : "critical";

  const rootName = root?.service ?? "none";
  const remediations = root
    ? [
        {
          priority: status === "critical" ? "critical" : "high",
          action: `Restart ${root.service}`,
          reason: `${root.service} has the lowest health score (${root.healthScore})`,
          command: `kubectl rollout restart deployment/${root.service}`,
          impact: `${impacted.size} downstream services may recover`,
        },
        {
          priority: "medium",
          action: `Scale ${root.service}`,
          reason: "Reduce pressure while root cause is investigated",
          command: `kubectl scale deployment/${root.service} --replicas=2`,
        },
      ]
    : [];

  return {
    graphPods,
    root_cause: rootName,
    confidence: root ? Math.max(0.55, Math.min(0.98, (100 - root.healthScore) / 100)) : 0.4,
    status,
    healthPercent: clusterHealth,
    summary:
      root && status !== "healthy"
        ? `${root.service} is the most probable root cause; ${impacted.size} dependent services impacted.`
        : "No major dependency anomaly detected.",
    remediations,
  };
}
