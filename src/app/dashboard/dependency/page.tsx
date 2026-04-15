"use client";

import { useEffect, useState } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { useSelectedEndpointId } from "@/components/dashboard/use-endpoint";
import { readSelectedEndpoint } from "@/lib/endpoints-client";
import DependencyGraphSVG, { Pod } from "@/components/dashboard/dependency-graph-svg";
import { DependencyTree } from "@/components/dashboard/dependency-tree";

type GraphPod = {
  id: string;
  name: string;
  status: "running" | "failed" | "pending";
  failureType: "healthy" | "root-cause" | "cascading";
  failureReason?: string;
  dependsOn: string[];
};

type Remediation = {
  priority: string;
  action: string;
  reason: string;
  command: string;
  impact?: string;
};

type AnalysisPayload = {
  root_cause: string;
  action: string;
  confidence: number;
  summary: string;
  status: "healthy" | "degraded" | "critical";
  healthPercent: number;
  remediations: Remediation[];
  graphPods: GraphPod[];
};

function logicalServiceKey(name: string): string {
  return name.toLowerCase().split("-")[0] || name.toLowerCase();
}

function inferDependenciesByServiceName(graphPods: GraphPod[]): Map<string, string[]> {
  const byKey = new Map<string, string>();
  graphPods.forEach((p) => {
    const k = logicalServiceKey(p.name);
    if (!byKey.has(k)) byKey.set(k, p.name);
  });

  // Opinionated defaults for common K8s microservice stacks (e.g., Online Boutique style)
  const template: Record<string, string[]> = {
    frontend: ["checkoutservice", "productcatalogservice", "recommendationservice", "cartservice", "currencyservice"],
    checkoutservice: ["cartservice", "paymentservice", "shippingservice", "emailservice", "productcatalogservice", "currencyservice"],
    cartservice: ["redis"],
    recommendationservice: ["productcatalogservice"],
    paymentservice: [],
    productcatalogservice: [],
    currencyservice: [],
    emailservice: [],
    shippingservice: [],
    adservice: [],
    loadgenerator: ["frontend"],
    otel: [],
    kube: [],
    coredns: [],
    etcd: [],
    redis: [],
  };

  const resolveTemplateKey = (serviceKey: string): string => {
    if (serviceKey.startsWith("redis")) return "redis";
    if (serviceKey.startsWith("otel")) return "otel";
    if (serviceKey.startsWith("kube")) return "kube";
    if (serviceKey.startsWith("frontend")) return "frontend";
    if (serviceKey.startsWith("checkout")) return "checkoutservice";
    if (serviceKey.startsWith("productcatalog")) return "productcatalogservice";
    if (serviceKey.startsWith("recommendation")) return "recommendationservice";
    if (serviceKey.startsWith("payment")) return "paymentservice";
    if (serviceKey.startsWith("shipping")) return "shippingservice";
    if (serviceKey.startsWith("currency")) return "currencyservice";
    if (serviceKey.startsWith("email")) return "emailservice";
    if (serviceKey.startsWith("cart")) return "cartservice";
    if (serviceKey.startsWith("loadgenerator")) return "loadgenerator";
    if (serviceKey.startsWith("adservice")) return "adservice";
    if (serviceKey.startsWith("coredns")) return "coredns";
    if (serviceKey.startsWith("etcd")) return "etcd";
    return serviceKey;
  };

  const inferred = new Map<string, string[]>();
  graphPods.forEach((pod) => {
    const serviceKey = resolveTemplateKey(logicalServiceKey(pod.name));
    const deps = template[serviceKey] || [];
    const resolved = deps
      .map((depKey) => {
        for (const [k, actualName] of byKey.entries()) {
          if (k.startsWith(depKey)) return actualName;
        }
        return undefined;
      })
      .filter((d): d is string => Boolean(d));
    inferred.set(pod.name, resolved);
  });

  return inferred;
}

// Helper to convert GraphPod to SVG Pod format
const convertGraphPodToSvgPod = (graphPods: GraphPod[], rootCauseName?: string): Pod[] => {
  const idToName = new Map(graphPods.map((p) => [p.id, p.name]));
  const inferredDeps = inferDependenciesByServiceName(graphPods);

  const normalizedRoot = rootCauseName?.toLowerCase().trim();
  const explicitRoot = graphPods.find((p) => p.failureType === "root-cause")?.name;
  const namedRoot = graphPods.find((p) => p.name.toLowerCase() === normalizedRoot)?.name;
  const fallbackRoot =
    graphPods.find((p) => p.name.toLowerCase().includes("frontend"))?.name ||
    graphPods.find((p) => p.status === "failed")?.name ||
    graphPods[0]?.name;
  const effectiveRoot = explicitRoot || namedRoot || fallbackRoot;

  const hasRealEdges = graphPods.some((p) => (p.dependsOn || []).length > 0);

  return graphPods.map((pod) => {
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

    // Normalize dependsOn to pod names (input can contain ids or names)
    const normalizedDependsOn = (pod.dependsOn || []).map((dep) => idToName.get(dep) || dep);
    const effectiveDependsOn = hasRealEdges
      ? normalizedDependsOn
      : (inferredDeps.get(pod.name) || []);

    // Calculate impactedBy: which pods depend on this pod
    const impactedBy = graphPods
      .filter((p) => {
        const deps = hasRealEdges
          ? (p.dependsOn || []).map((dep) => idToName.get(dep) || dep)
          : (inferredDeps.get(p.name) || []);
        return deps.includes(pod.name);
      })
      .map((p) => p.name);

    return {
      name: pod.name,
      status: statusMap[pod.status],
      isRootCause: pod.name === effectiveRoot,
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

  useEffect(() => {
    if (!endpointId) {
      setAnalysis(null);
      setError(null);
      return;
    }

    const poll = async () => {
      try {
        setLoading(true);
        const selected = await readSelectedEndpoint();
        if (!selected) {
          setAnalysis(null);
          setError("Selected endpoint not found");
          return;
        }

        const u = new URL("/api/ai-agents/analyze", window.location.origin);
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
    };

    void poll();
    const id = setInterval(() => {
      void poll();
    }, 6000);

    return () => clearInterval(id);
  }, [endpointId]);

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

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardBody>
            <div className="text-xs text-muted">AI Status</div>
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
            <div className="text-xs text-muted">Root Cause</div>
            <div className="mt-1 text-xl font-semibold text-[#1f2b33]">
              {analysis?.root_cause ?? "-"}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs text-muted">Confidence</div>
            <div className="mt-1 text-xl font-semibold text-[#1f2b33]">
              {typeof analysis?.confidence === "number" ? `${Math.round(analysis.confidence * 100)}%` : "-"}
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">AI Summary</div>
          <div className="text-sm text-muted">Live output from the integrated ai_agents branch.</div>
        </CardHeader>
        <CardBody>
          <div className="text-sm text-[#4f5d68]">{analysis?.summary ?? "Waiting for analysis..."}</div>
        </CardBody>
      </Card>

      {analysis?.graphPods?.length ? (
        <div className="space-y-4">
          <div className="rounded-lg shadow-lg overflow-hidden bg-white">
            <DependencyGraphSVG 
              pods={convertGraphPodToSvgPod(analysis.graphPods, analysis.root_cause)} 
              width={1200}
              height={700}
            />
          </div>
          <DependencyTree
            pods={analysis.graphPods.map((p) => ({
              id: p.id,
              name: p.name,
              status: p.status,
              failureType: p.failureType,
              message: p.failureReason,
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

      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Suggested Actions</div>
          <div className="text-sm text-muted">Top remediations generated by the AI agent.</div>
        </CardHeader>
        <CardBody>
          {analysis?.remediations?.length ? (
            <div className="space-y-3">
              {analysis.remediations.slice(0, 6).map((r, idx) => (
                <div key={`${r.action}-${idx}`} className="rounded-xl border border-[#e9dece] bg-[#fff8ee] p-3">
                  <div className="text-xs uppercase tracking-[0.12em] text-muted">{r.priority}</div>
                  <div className="mt-1 text-sm font-semibold text-[#1f2b33]">{r.action}</div>
                  <div className="mt-1 text-sm text-[#4f5d68]">{r.reason}</div>
                  <div className="mt-2 rounded-md bg-[#f6edde] px-2 py-1 text-xs text-[#5b6872]">{r.command}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted">No remediation needed right now.</div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
