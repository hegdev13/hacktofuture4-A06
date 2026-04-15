import path from "path";
import { existsSync } from "fs";
import { spawnSync } from "child_process";
import type { ClusterSnapshot } from "@/lib/kube/types";
import { buildDependencyImpact } from "@/lib/observability/dependency";

type AgentPod = {
  name: string;
  status: string;
  cpu?: number;
  memory?: number;
};

type RcaRootCause = {
  name: string;
  status: string;
  cpu?: number;
  memory?: number;
};

type RcaRemediation = {
  priority: string;
  action: string;
  reason: string;
  command: string;
  impact?: string;
};

type RcaResult = {
  status: "healthy" | "degraded" | "critical";
  rootCauses: RcaRootCause[];
  affectedPods: string[];
  impactedCount: number;
  healthPercent: number;
  remediations: RcaRemediation[];
  summary: string;
};

type PodDependencyMap = Record<string, string[]>;

export type AgentAnalysis = {
  root_cause: string;
  action: string;
  confidence: number;
  summary: string;
  status: "healthy" | "degraded" | "critical";
  healthPercent: number;
  remediations: RcaRemediation[];
  graphPods: Array<{
    id: string;
    name: string;
    status: "running" | "failed" | "pending";
    failureType: "healthy" | "root-cause" | "cascading";
    failureReason?: string;
    dependsOn: string[];
  }>;
};

function toLogicalPodName(podName: string) {
  // Strip hash/suffixes to better align with dependency map keys.
  return podName.split("-").slice(0, 2).join("-") || podName;
}

function mapStatus(status: string): "running" | "failed" | "pending" {
  const s = status.toLowerCase();
  if (s.includes("running") || s === "ok") return "running";
  if (s.includes("pending") || s.includes("init")) return "pending";
  return "failed";
}

function runExternalRca(pods: AgentPod[]): { result: RcaResult; dependencyMap: PodDependencyMap } {
  const bridgePath = path.join(process.cwd(), "ai_agents", "rca-bridge.cjs");
  if (!existsSync(bridgePath)) {
    throw new Error("AI bridge file not found at ai_agents/rca-bridge.cjs");
  }

  const proc = spawnSync(process.execPath, [bridgePath], {
    input: JSON.stringify({ pods }),
    encoding: "utf-8",
    cwd: process.cwd(),
  });

  if (proc.status !== 0) {
    const err = proc.stderr?.trim() || proc.stdout?.trim() || "Unknown bridge execution error";
    throw new Error(`AI bridge execution failed: ${err}`);
  }

  const parsed = JSON.parse(proc.stdout || "{}") as {
    result?: RcaResult;
    dependencyMap?: PodDependencyMap;
  };

  if (!parsed.result) {
    throw new Error("AI bridge returned invalid payload");
  }

  return {
    result: parsed.result,
    dependencyMap: parsed.dependencyMap ?? {},
  };
}

export function analyzeSnapshotWithAiAgent(snapshot: ClusterSnapshot): AgentAnalysis {
  const pods = snapshot.pods.map((p) => ({
    name: toLogicalPodName(p.pod_name),
    status: p.status.toLowerCase().includes("running") ? "Running" : p.status,
    cpu: typeof p.cpu_usage === "number" ? p.cpu_usage : undefined,
    memory: typeof p.memory_usage === "number" ? p.memory_usage : undefined,
  }));

  try {
    const { result, dependencyMap } = runExternalRca(pods);
    const rootCause = result.rootCauses[0]?.name ?? "No root cause";
    const action = result.remediations[0]?.action ?? "No action needed";

    const confidence =
      result.rootCauses.length === 0
        ? 0.95
        : result.rootCauses.length === 1
          ? 0.86
          : 0.72;

    const graphPods = pods.map((p) => {
      const isRoot = result.rootCauses.some((r) => r.name === p.name);
      const isAffected = result.affectedPods.includes(p.name);
      return {
        id: p.name,
        name: p.name,
        status: mapStatus(p.status),
        failureType: (isRoot ? "root-cause" : isAffected ? "cascading" : "healthy") as
          | "healthy"
          | "root-cause"
          | "cascading",
        failureReason: isAffected ? "Impacted by upstream dependency failure" : undefined,
        dependsOn: dependencyMap[p.name] ?? [],
      };
    });

    return {
      root_cause: rootCause,
      action,
      confidence,
      summary: result.summary,
      status: result.status,
      healthPercent: result.healthPercent,
      remediations: result.remediations,
      graphPods,
    };
  } catch {
    const fallback = buildDependencyImpact(snapshot);
    return {
      root_cause: fallback.root_cause,
      action: fallback.remediations[0]?.action ?? "No action needed",
      confidence: fallback.confidence,
      summary: fallback.summary,
      status: fallback.status,
      healthPercent: fallback.healthPercent,
      remediations: fallback.remediations,
      graphPods: fallback.graphPods.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        failureType: p.failureType,
        failureReason: p.failureReason,
        dependsOn: p.dependsOn,
      })),
    };
  }
}
