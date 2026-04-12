"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatBytes, formatNumber } from "@/lib/format";
import { loadEndpoints, type SnapshotRow } from "@/lib/frontend-mock";
import { DependencyGraphVisual } from "@/components/dashboard/dependency-graph-visual";
import { convertMetricsToPods, identifyRootCause } from "@/lib/pod-dependency";
import type { Pod } from "@/lib/pod-dependency";

function statusColor(status: string) {
  const s = status.toLowerCase();
  if (s.includes("running") || s === "ok") return "text-emerald-300";
  if (s.includes("pending")) return "text-amber-300";
  if (s.includes("crashloop") || s.includes("error") || s.includes("failed")) return "text-rose-300";
  return "text-zinc-300";
}

type UpstreamPod = {
  pod_name: string;
  namespace?: string;
  status: string;
  cpu_usage?: number | null;
  memory_usage?: number | null;
  restart_count?: number | null;
};

type PollHistoryPoint = {
  tsLabel: string;
  total: number;
  running: number;
  avgCpu: number | null;
  avgMem: number | null;
};

function readSelectedEndpoint(): { id: string; ngrok_url: string } | null {
  if (typeof window === "undefined") return null;
  const id = localStorage.getItem("kubepulse.endpointId");
  if (!id) return null;
  const ep = loadEndpoints().find((e) => e.id === id);
  if (!ep) return null;
  return { id: ep.id, ngrok_url: ep.ngrok_url };
}

function podsToRows(endpointId: string, pods: UpstreamPod[], fetchedAt: string): SnapshotRow[] {
  return pods.map((p) => ({
    id: crypto.randomUUID(),
    endpoint_id: endpointId,
    pod_name: p.pod_name,
    namespace: p.namespace ?? "default",
    status: p.status,
    cpu_usage: typeof p.cpu_usage === "number" ? p.cpu_usage : null,
    memory_usage: typeof p.memory_usage === "number" ? p.memory_usage : null,
    restart_count: p.restart_count ?? 0,
    timestamp: fetchedAt,
  }));
}

function summarizePods(pods: UpstreamPod[]) {
  const total = pods.length;
  let running = 0;
  let cpuSum = 0;
  let cpuCount = 0;
  let memSum = 0;
  let memCount = 0;
  for (const p of pods) {
    if (p.status.toLowerCase().includes("running")) running += 1;
    if (typeof p.cpu_usage === "number") {
      cpuSum += p.cpu_usage;
      cpuCount += 1;
    }
    if (typeof p.memory_usage === "number") {
      memSum += p.memory_usage;
      memCount += 1;
    }
  }
  return {
    total,
    running,
    avgCpu: cpuCount ? cpuSum / cpuCount : null,
    avgMem: memCount ? memSum / memCount : null,
  };
}

export default function DashboardOverviewPage() {
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [history, setHistory] = useState<PollHistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [uiReady, setUiReady] = useState(false);
  const [selectedEp, setSelectedEp] = useState<{ id: string; ngrok_url: string } | null>(null);
  const [metricsData, setMetricsData] = useState<any>(null);
  const [dependencyPods, setDependencyPods] = useState<Pod[]>([]);

  const poll = useCallback(async () => {
    const sel = readSelectedEndpoint();
    setSelectedEp(sel);
    if (!sel) {
      setRows([]);
      setFetchError(null);
      return;
    }
    setLoading(true);
    setFetchError(null);
    try {
      const u = new URL("/api/dashboard/pods", window.location.origin);
      u.searchParams.set("ngrok_url", sel.ngrok_url);
      const res = await fetch(u.toString());
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        pods?: UpstreamPod[];
        fetched_at?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      if (!data.pods || !Array.isArray(data.pods)) {
        throw new Error("Invalid response: missing pods");
      }
      const fetchedAt = data.fetched_at ?? new Date().toISOString();
      const normalized: UpstreamPod[] = data.pods.map((p) => ({
        pod_name: p.pod_name,
        namespace: p.namespace,
        status: p.status,
        cpu_usage: p.cpu_usage ?? null,
        memory_usage: p.memory_usage ?? null,
        restart_count: p.restart_count ?? 0,
      }));
      setRows(podsToRows(sel.id, normalized, fetchedAt));
      const s = summarizePods(normalized);
      const tsLabel = new Date().toISOString().slice(11, 19);
      setHistory((prev) => {
        const next = [
          ...prev.slice(-119),
          {
            tsLabel,
            total: s.total,
            running: s.running,
            avgCpu: s.avgCpu,
            avgMem: s.avgMem,
          },
        ];
        return next;
      });

      // Fetch metrics for dependency graph
      try {
        const metricsRes = await fetch("/api/metrics/context");
        if (metricsRes.ok) {
          const metricsJson = await metricsRes.json();
          setMetricsData(metricsJson);
          
          // Define dependency map for all pods
          const dependencyMap: Record<string, string[]> = {
            "api-server": [],
            "database-primary": [],
            "cache-redis": ["database-primary"],
            "worker-1": ["cache-redis", "database-primary"],
            "worker-2": ["cache-redis", "database-primary"],
            "web-frontend": ["api-server", "worker-1"],
            "monitoring-agent": ["api-server"],
            "log-aggregator": ["database-primary"],
          };

          // Extract failed pods from the actual pod data and alerts
          const failedPodMap = new Map<string, string>();
          
          // First, check the pods array for failures
          if (metricsJson.pods && Array.isArray(metricsJson.pods)) {
            metricsJson.pods.forEach((pod: any) => {
              const status = pod.status?.toLowerCase() || "";
              if (status !== "running" && status !== "pending") {
                failedPodMap.set(pod.name, `Pod status: ${pod.status}`);
              }
            });
          }
          
          // Also extract from alerts for additional context
          if (metricsJson.alerts && Array.isArray(metricsJson.alerts)) {
            metricsJson.alerts.forEach((alert: any) => {
              const message = alert.message || "";
              const severity = alert.severity || "";
              
              if (severity === "critical" || severity === "warning") {
                // Extract pod names from various alert formats
                const criticalWords = ["failed", "crash", "error", "issue", "down", "broken"];
                const hasCritical = criticalWords.some(word => 
                  message.toLowerCase().includes(word)
                );
                
                if (hasCritical) {
                  // Try to find pod name in dependencies
                  Object.keys(dependencyMap).forEach(podName => {
                    if (message.toLowerCase().includes(podName)) {
                      failedPodMap.set(podName, message);
                    }
                  });
                }
              }
            });
          }

          // Create pods from dependency map with dynamic failure status
          const dynamicPods: Pod[] = Object.entries(dependencyMap).map(([podName, dependencies]) => {
            const failureMessage = failedPodMap.get(podName);
            
            return {
              id: podName,
              name: podName,
              status: failureMessage ? "failed" : "running",
              message: failureMessage || undefined,
              dependsOn: dependencies,
            };
          });

          setDependencyPods(dynamicPods);
        }
      } catch (e) {
        console.error("Failed to fetch metrics for dependency graph:", e);
      }
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const onEp = () => {
      setHistory([]);
      poll();
    };
    poll();
    setUiReady(true);
    const id = setInterval(poll, 4000);
    window.addEventListener("kubepulse-endpoint", onEp);
    return () => {
      clearInterval(id);
      window.removeEventListener("kubepulse-endpoint", onEp);
    };
  }, [poll]);

  const latestByPod = useMemo(() => {
    const map = new Map<string, SnapshotRow>();
    for (const r of rows) {
      const key = `${r.namespace}/${r.pod_name}`;
      if (!map.has(key)) map.set(key, r);
    }
    return Array.from(map.values()).sort((a, b) => a.pod_name.localeCompare(b.pod_name));
  }, [rows]);

  const cluster = useMemo(() => {
    const totalPods = latestByPod.length;
    let running = 0;
    let failed = 0;
    let pending = 0;
    let cpuSum = 0;
    let memSum = 0;
    let cpuCount = 0;
    let memCount = 0;
    for (const r of latestByPod) {
      const s = r.status.toLowerCase();
      if (s.includes("running")) running += 1;
      else if (s.includes("pending")) pending += 1;
      else if (s.includes("crashloop") || s.includes("error") || s.includes("failed")) failed += 1;
      if (typeof r.cpu_usage === "number") {
        cpuSum += r.cpu_usage;
        cpuCount += 1;
      }
      if (typeof r.memory_usage === "number") {
        memSum += r.memory_usage;
        memCount += 1;
      }
    }
    return {
      totalPods,
      running,
      failed,
      pending,
      avgCpu: cpuCount ? cpuSum / cpuCount : null,
      avgMem: memCount ? memSum / memCount : null,
    };
  }, [latestByPod]);

  const hasResourceMetrics = useMemo(
    () => history.some((h) => h.avgCpu != null || h.avgMem != null),
    [history],
  );

  const podCountSeries = useMemo(() => history.map((h) => ({ ...h })), [history]);

  const resourceSeries = useMemo(
    () =>
      history.map((h) => ({
        tsLabel: h.tsLabel,
        cpu: h.avgCpu ?? 0,
        mem: h.avgMem ?? 0,
      })),
    [history],
  );

  if (!uiReady) {
    return (
      <Card>
        <CardBody>
          <div className="text-sm text-zinc-400">Loading dashboard…</div>
        </CardBody>
      </Card>
    );
  }

  if (!selectedEp) {
    return (
      <Card>
        <CardHeader>
          <div className="text-lg font-semibold">No endpoint selected</div>
          <div className="text-sm text-zinc-400">
            Add an ngrok endpoint in Setup, then select it from the top bar.
          </div>
        </CardHeader>
        <CardBody>
          <a className="text-indigo-300 hover:underline" href="/dashboard/setup">
            Go to Setup
          </a>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-3xl font-bold text-white">Cluster Status</h1>
          <p className="text-gray-400 text-sm mt-1">Real-time monitoring and pod dependency analysis</p>
        </div>
        <div className={`px-4 py-2 rounded-lg font-medium ${
          cluster.failed > 0 
            ? "bg-rose-900/30 border border-rose-700/50 text-rose-300"
            : "bg-emerald-900/30 border border-emerald-700/50 text-emerald-300"
        }`}>
          {cluster.failed > 0 ? `⚠️ ${cluster.failed} Issue${cluster.failed === 1 ? "" : "s"}` : "✅ Healthy"}
        </div>
      </div>

      {fetchError ? (
        <Card>
          <CardBody>
            <div className="text-sm text-rose-300">Could not load cluster: {fetchError}</div>
            <div className="mt-1 text-xs text-zinc-500">
              Check that the saved ngrok base URL matches your tunnel (HTTPS) and exposes{" "}
              <code className="text-zinc-400">/pods</code> or a metrics path.
            </div>
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <Card className="bg-gradient-to-br from-blue-950 to-blue-900 border-blue-800/50">
          <CardBody>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="text-xs text-blue-300 font-medium">Total Pods</div>
                <div className="mt-2 text-3xl font-bold text-white">{cluster.totalPods}</div>
              </div>
              <div className="w-12 h-12 bg-blue-900/50 rounded-lg flex items-center justify-center">
                <span className="text-2xl">📦</span>
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className={`bg-gradient-to-br ${
          cluster.failed > 0 ? "from-rose-950 to-rose-900 border-rose-800/50" : "from-emerald-950 to-emerald-900 border-emerald-800/50"
        }`}>
          <CardBody>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className={`text-xs font-medium ${cluster.failed > 0 ? "text-rose-300" : "text-emerald-300"}`}>
                  Status
                </div>
                <div className="mt-2 text-sm font-semibold space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 bg-emerald-400 rounded-full"></span>
                    <span className="text-white">{cluster.running} Running</span>
                  </div>
                  {cluster.failed > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 bg-rose-400 rounded-full animate-pulse"></span>
                      <span className="text-rose-300">{cluster.failed} Failed</span>
                    </div>
                  )}
                  {cluster.pending > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 bg-amber-400 rounded-full"></span>
                      <span className="text-amber-300">{cluster.pending} Pending</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="w-12 h-12 bg-opacity-50 rounded-lg flex items-center justify-center text-2xl">
                {cluster.failed > 0 ? "⚠️" : "✅"}
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className="bg-gradient-to-br from-purple-950 to-purple-900 border-purple-800/50">
          <CardBody>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="text-xs text-purple-300 font-medium">Avg CPU</div>
                <div className="mt-2 text-3xl font-bold text-white">
                  {cluster.avgCpu == null ? "—" : formatNumber(cluster.avgCpu)}%
                </div>
              </div>
              <div className="w-12 h-12 bg-purple-900/50 rounded-lg flex items-center justify-center">
                <span className="text-2xl">⚡</span>
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className="bg-gradient-to-br from-cyan-950 to-cyan-900 border-cyan-800/50">
          <CardBody>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="text-xs text-cyan-300 font-medium">Avg Memory</div>
                <div className="mt-2 text-3xl font-bold text-white">
                  {cluster.avgMem == null ? "—" : formatBytes(cluster.avgMem)}
                </div>
              </div>
              <div className="w-12 h-12 bg-cyan-900/50 rounded-lg flex items-center justify-center">
                <span className="text-2xl">💾</span>
              </div>
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="font-semibold">Pod counts (poll history)</div>
            <div className="text-xs text-zinc-400">Live data from your ngrok base URL</div>
          </CardHeader>
          <CardBody className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={podCountSeries}>
                <XAxis dataKey="tsLabel" tick={{ fill: "#9CA3AF", fontSize: 12 }} />
                <YAxis tick={{ fill: "#9CA3AF", fontSize: 12 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: "#0B1220",
                    border: "1px solid rgba(255,255,255,0.1)",
                    color: "#E5E7EB",
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="total" name="Total" stroke="#6366F1" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="running" name="Running" stroke="#22C55E" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="font-semibold">CPU &amp; memory (avg over pods)</div>
            <div className="text-xs text-zinc-400">
              {hasResourceMetrics
                ? "Values from upstream when pods include cpu_usage / memory_usage"
                : "Your /pods payload has no per-pod CPU or memory; add those fields for this chart"}
            </div>
          </CardHeader>
          <CardBody className="h-56">
            {hasResourceMetrics ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={resourceSeries}>
                  <XAxis dataKey="tsLabel" tick={{ fill: "#9CA3AF", fontSize: 12 }} />
                  <YAxis tick={{ fill: "#9CA3AF", fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      background: "#0B1220",
                      border: "1px solid rgba(255,255,255,0.1)",
                      color: "#E5E7EB",
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="cpu" name="CPU (avg)" stroke="#6366F1" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="mem" name="Mem (bytes)" stroke="#22C55E" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                No resource samples yet — table and pod counts above are live.
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {dependencyPods.length > 0 && <DependencyGraphVisual pods={dependencyPods} />}

      <Card className="border-slate-800/50">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold text-white flex items-center gap-2">
                <span className="text-lg">📋</span>
                Pod Health
              </div>
              <div className="text-xs text-zinc-400 mt-1">
                Latest status per pod {loading && <span className="ml-2 animate-pulse">● Refreshing</span>}
              </div>
            </div>
            <div className="text-sm text-gray-400">
              {latestByPod.length} pods
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="text-xs text-gray-400 border-b border-slate-800/50">
                <tr>
                  <th className="py-3 px-4 text-left font-semibold tracking-wider">Pod Name</th>
                  <th className="py-3 px-4 text-left font-semibold tracking-wider">Namespace</th>
                  <th className="py-3 px-4 text-left font-semibold tracking-wider">Status</th>
                  <th className="py-3 px-4 text-center font-semibold tracking-wider">Restarts</th>
                </tr>
              </thead>
              <tbody>
                {latestByPod.map((r) => {
                  const isHealthy = r.status.toLowerCase().includes("running");
                  return (
                    <tr 
                      key={`${r.namespace}/${r.pod_name}`} 
                      className={`border-b border-slate-800/30 transition-colors hover:bg-slate-900/30 ${
                        isHealthy ? "" : "bg-slate-950/50"
                      }`}
                    >
                      <td className="py-3 px-4 font-medium text-white">{r.pod_name}</td>
                      <td className="py-3 px-4 text-gray-400">{r.namespace}</td>
                      <td className={cn("py-3 px-4 font-semibold flex items-center gap-2", statusColor(r.status))}>
                        <span className={`w-2 h-2 rounded-full ${
                          isHealthy ? "bg-emerald-400" : "bg-rose-400"
                        }`}></span>
                        {r.status}
                      </td>
                      <td className="py-3 px-4 text-center text-gray-400">
                        {r.restart_count > 0 && <span className="text-amber-400 font-semibold">{r.restart_count}</span>}
                        {r.restart_count === 0 && <span className="text-emerald-400">-</span>}
                      </td>
                    </tr>
                  );
                })}
                {!latestByPod.length && !fetchError ? (
                  <tr>
                    <td className="py-8 px-4 text-gray-500 text-center" colSpan={4}>
                      <span className="animate-pulse">Loading pod list…</span>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
