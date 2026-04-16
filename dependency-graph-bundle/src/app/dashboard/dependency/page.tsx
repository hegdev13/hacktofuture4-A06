"use client";

/**
 * Dependency Graph Page
 * Displays service dependencies and pod states with real-time propagation
 * Shows how services depend on each other and cascade failures
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { useSelectedEndpointId } from "@/components/dashboard/use-endpoint";
import { readSelectedEndpoint } from "@/lib/endpoints-client";
import DependencyGraphSVG, { Pod } from "@/components/dashboard/dependency-graph-svg";
import { DependencyTree } from "@/components/dashboard/dependency-tree";

type GraphPod = {
  id: string;
  name: string;
  status: "running" | "failed" | "pending";
  dependsOn: string[];
  healthScore?: number;
};

type AnalysisPayload = {
  graphPods: GraphPod[];
  status: "healthy" | "degraded" | "critical";
  healthPercent: number;
  summary: string;
};

function normalizeServiceKey(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s*\(.*$/, "")
    .replace(/\s*\[.*$/, "")
    .replace(/\s+.*/, "")
    .replace(/^https?:\/\//, "")
    .replace(/:\d+$/, "")
    .replace(/\.svc\.cluster\.local$/, "")
    .split(".")[0]
    .replace(/-[a-f0-9]{8,10}-[a-z0-9]{5}$/i, "")
    .replace(/-\d+$/, "")
    .replace(/-service$/, "service")
    .replace(/[^a-z0-9-]/g, "");
}

function statusRank(status: GraphPod["status"]): number {
  if (status === "failed") return 3;
  if (status === "pending") return 2;
  return 1;
}

function consolidateGraphPods(graphPods: GraphPod[]): GraphPod[] {
  const byKey = new Map<string, GraphPod>();

  for (const pod of graphPods) {
    const key = normalizeServiceKey(pod.name) || normalizeServiceKey(pod.id) || pod.name.toLowerCase();
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, {
        ...pod,
        id: key,
        name: key,
        dependsOn: [...(pod.dependsOn || [])],
      });
      continue;
    }

    byKey.set(key, {
      ...existing,
      status: statusRank(pod.status) > statusRank(existing.status) ? pod.status : existing.status,
      healthScore: Math.min(existing.healthScore ?? 100, pod.healthScore ?? 100),
      dependsOn: Array.from(new Set([...(existing.dependsOn || []), ...(pod.dependsOn || [])])),
    });
  }

  return Array.from(byKey.values());
}

function inferDependenciesByServiceName(graphPods: GraphPod[]): Map<string, string[]> {
  const byLower = new Map(graphPods.map((p) => [p.name.toLowerCase(), p.name]));
  const map = new Map<string, string[]>();

  const resolve = (name: string) => byLower.get(name.toLowerCase());

  const add = (source: string, candidates: string[]) => {
    const src = resolve(source);
    if (!src) return;
    const deps = candidates
      .map((c) => resolve(c))
      .filter((d): d is string => Boolean(d) && d !== src);
    map.set(src, Array.from(new Set(deps)));
  };

  add("frontend", [
    "adservice",
    "cartservice",
    "checkoutservice",
    "currencyservice",
    "productcatalogservice",
    "recommendationservice",
    "shippingservice",
  ]);

  add("checkoutservice", [
    "cartservice",
    "currencyservice",
    "paymentservice",
    "productcatalogservice",
    "shippingservice",
    "emailservice",
  ]);

  add("recommendationservice", ["productcatalogservice"]);
  add("cartservice", ["redis-cart", "productcatalogservice"]);
  add("paymentservice", ["emailservice", "currencyservice"]);

  for (const pod of graphPods) {
    if (map.has(pod.name)) continue;
    const low = pod.name.toLowerCase();
    if (low.includes("frontend") || low.includes("ui") || low.includes("web")) {
      const deps = graphPods
        .map((p) => p.name)
        .filter((n) => n !== pod.name && /service|api|backend/i.test(n));
      if (deps.length) map.set(pod.name, deps);
    } else if (low.includes("api") || low.includes("backend")) {
      const deps = graphPods
        .map((p) => p.name)
        .filter((n) => n !== pod.name && /db|postgres|mysql|redis|cache/i.test(n));
      if (deps.length) map.set(pod.name, deps);
    }
  }

  return map;
}

// Helper to convert GraphPod to SVG Pod format
const convertGraphPodToSvgPod = (graphPods: GraphPod[]): Pod[] => {
  const consolidatedPods = consolidateGraphPods(graphPods);

  const normalize = (value: string) =>
    value
      .toLowerCase()
      .trim()
      .replace(/\s*\(.*$/, "")
      .replace(/\s*\[.*$/, "")
      .replace(/\s+.*/, "")
      .replace(/^https?:\/\//, "")
      .replace(/:\d+$/, "")
      .replace(/\.svc\.cluster\.local$/, "")
      .split(".")[0]
      .replace(/-[a-f0-9]{8,10}-[a-z0-9]{5}$/i, "")
      .replace(/-\d+$/, "")
      .replace(/[^a-z0-9-]/g, "");

  const idToName = new Map(consolidatedPods.map((p) => [p.id, p.name]));
  const nameToName = new Map(consolidatedPods.map((p) => 
    [p.name.toLowerCase(), p.name]
  ));
  const aliasToName = new Map<string, string>();
  const inferredFallback = inferDependenciesByServiceName(consolidatedPods);
  const apiHasAnyEdges = consolidatedPods.some((p) => (p.dependsOn || []).length > 0);

  for (const pod of consolidatedPods) {
    const base = normalize(pod.name);
    const compact = base.replace(/-/g, "");
    aliasToName.set(base, pod.name);
    aliasToName.set(compact, pod.name);
    if (base.endsWith("-service")) {
      aliasToName.set(base.replace(/-service$/, "service"), pod.name);
    }
    if (base.endsWith("service")) {
      aliasToName.set(base.replace(/service$/, "-service"), pod.name);
    }
  }

  const resolveDepToPodName = (dep: string): string => {
    if (idToName.has(dep)) return idToName.get(dep)!;
    const lower = dep.toLowerCase();
    if (nameToName.has(lower)) return nameToName.get(lower)!;
    const normalized = normalize(dep);
    const compact = normalized.replace(/-/g, "");
    return aliasToName.get(normalized) || aliasToName.get(compact) || dep;
  };

  return consolidatedPods.map((pod) => {
    // Infer node type from pod name patterns
    let nodeType: "gateway" | "web" | "compute" | "storage" | "system" = "compute";
    if (
      pod.name.includes("gateway") ||
      pod.name.includes("ingress") ||
      pod.name.includes("proxy")
    ) {
      nodeType = "gateway";
    } else if (
      pod.name.includes("api") ||
      pod.name.includes("web") ||
      pod.name.includes("ui")
    ) {
      nodeType = "web";
    } else if (
      pod.name.includes("db") ||
      pod.name.includes("postgres") ||
      pod.name.includes("mysql") ||
      pod.name.includes("redis") ||
      pod.name.includes("cache") ||
      pod.name.includes("storage")
    ) {
      nodeType = "storage";
    } else if (
      pod.name.includes("system") ||
      pod.name.includes("kube") ||
      pod.name.includes("agent") ||
      pod.name.includes("monitor")
    ) {
      nodeType = "system";
    }

    // Map status to uppercase
    const statusMap: {
      [key in "running" | "failed" | "pending"]: "RUNNING" | "FAILED" | "PENDING";
    } = {
      running: "RUNNING",
      failed: "FAILED",
      pending: "PENDING",
    };

    const rawDependsOn = apiHasAnyEdges
      ? (pod.dependsOn || [])
      : (inferredFallback.get(pod.name) || []);

    const effectiveDependsOn = rawDependsOn
      .map((dep) => resolveDepToPodName(dep))
      .filter((d) => d && d !== pod.name);

    // Calculate impactedBy: which pods depend on this pod
    const impactedBy = consolidatedPods
      .filter((p) => {
        const candidateDeps = apiHasAnyEdges
          ? (p.dependsOn || [])
          : (inferredFallback.get(p.name) || []);
        const deps = candidateDeps.map((dep) => resolveDepToPodName(dep));
        return deps.includes(pod.name);
      })
      .map((p) => p.name);

    return {
      name: pod.name,
      status: statusMap[pod.status],
      isRootCause: false,  // No RCA - all just visualization
      dependsOn: effectiveDependsOn,
      impactedBy,
      nodeType,
    } as Pod;
  });
};

export default function DependencyGraphPage() {
  const endpointId = useSelectedEndpointId();
  const [analysis, setAnalysis] = useState<AnalysisPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchAnalysis = useCallback(async () => {
    if (!endpointId) {
      setAnalysis(null);
      setError(null);
      return;
    }

    try {
      setLoading(true);
      const selected = await readSelectedEndpoint();
      if (!selected) {
        setAnalysis(null);
        setError("Selected endpoint not found");
        return;
      }

      const u = new URL("/api/dependencies/analyze", window.location.origin);
      u.searchParams.set("endpoint", selected.id);
      const res = await fetch(u.toString(), { cache: "no-store" });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        analysis?: AnalysisPayload;
      };

      if (!res.ok || !data.ok || !data.analysis) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      setAnalysis(data.analysis);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [endpointId]);

  useEffect(() => {
    if (!endpointId) {
      setAnalysis(null);
      setError(null);
      return;
    }

    void fetchAnalysis();
    const id = setInterval(() => {
      void fetchAnalysis();
    }, 6000);

    return () => clearInterval(id);
  }, [endpointId, fetchAnalysis]);

  if (!endpointId) {
    return (
      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Select an endpoint</div>
          <div className="text-sm text-muted">Use the top bar selector to load dependency graph analysis.</div>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <Card>
          <CardBody>
            <div className="text-sm text-danger">Dependency analysis failed: {error}</div>
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardBody>
            <div className="text-xs text-muted">Cluster Status</div>
            <div className="mt-1 text-xl font-semibold capitalize text-[#1f2b33]">
              {analysis?.status ?? (loading ? "loading" : "-")}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs text-muted">Cluster Health</div>
            <div className="mt-1 text-xl font-semibold text-[#1f2b33]">
              {typeof analysis?.healthPercent === "number" ? `${analysis.healthPercent}%` : "-"}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs text-muted">Services</div>
            <div className="mt-1 text-xl font-semibold text-[#1f2b33]">
              {analysis?.graphPods?.length ?? "-"}
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Dependency Graph Summary</div>
          <div className="text-sm text-muted">Real-time service dependency visualization and state propagation.</div>
        </CardHeader>
        <CardBody>
          <div className="text-sm text-[#4f5d68]">{analysis?.summary ?? "Analyzing dependencies..."}</div>
        </CardBody>
      </Card>

      {analysis?.graphPods?.length ? (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void fetchAnalysis()}
              disabled={loading}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Refreshing..." : "Refresh Graph"}
            </button>
          </div>
          <div className="rounded-lg shadow-lg overflow-hidden bg-white">
            <DependencyGraphSVG 
              pods={convertGraphPodToSvgPod(analysis.graphPods)} 
              width={1200}
              height={700}
            />
          </div>
          <DependencyTree
            pods={analysis.graphPods.map((p) => ({
              id: p.id,
              name: p.name,
              status: p.status,
              dependsOn: p.dependsOn,
            }))}
          />
        </div>
      ) : (
        <Card>
          <CardBody>
            <div className="text-sm text-muted">No graph data yet...</div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
