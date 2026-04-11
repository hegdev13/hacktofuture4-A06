"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatBytes, formatNumber } from "@/lib/format";
import { loadEndpoints, type SnapshotRow } from "@/lib/frontend-mock";

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
        <Card>
          <CardBody>
            <div className="text-xs text-zinc-400">Total pods</div>
            <div className="mt-1 text-2xl font-semibold">{cluster.totalPods}</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs text-zinc-400">Running / Failed / Pending</div>
            <div className="mt-1 text-2xl font-semibold">
              {cluster.running}
              <span className="text-zinc-500"> / </span>
              <span className="text-rose-300">{cluster.failed}</span>
              <span className="text-zinc-500"> / </span>
              <span className="text-amber-300">{cluster.pending}</span>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs text-zinc-400">Avg CPU (raw)</div>
            <div className="mt-1 text-2xl font-semibold">
              {cluster.avgCpu == null ? "—" : formatNumber(cluster.avgCpu)}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs text-zinc-400">Avg Memory</div>
            <div className="mt-1 text-2xl font-semibold">
              {cluster.avgMem == null ? "—" : formatBytes(cluster.avgMem)}
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

      <Card>
        <CardHeader>
          <div className="font-semibold">Pod health</div>
          <div className="text-xs text-zinc-400">
            Latest status per pod from upstream {loading ? "(refreshing…)" : ""}
          </div>
        </CardHeader>
        <CardBody>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="text-xs text-zinc-400">
                <tr className="border-b border-white/10">
                  <th className="py-2 text-left font-medium">Pod</th>
                  <th className="py-2 text-left font-medium">Namespace</th>
                  <th className="py-2 text-left font-medium">Status</th>
                  <th className="py-2 text-left font-medium">Restarts</th>
                </tr>
              </thead>
              <tbody>
                {latestByPod.map((r) => (
                  <tr key={`${r.namespace}/${r.pod_name}`} className="border-b border-white/5">
                    <td className="py-2 font-medium">{r.pod_name}</td>
                    <td className="py-2 text-zinc-300">{r.namespace}</td>
                    <td className={cn("py-2 font-medium", statusColor(r.status))}>{r.status}</td>
                    <td className="py-2 text-zinc-300">{r.restart_count}</td>
                  </tr>
                ))}
                {!latestByPod.length && !fetchError ? (
                  <tr>
                    <td className="py-4 text-zinc-400" colSpan={4}>
                      Loading pod list…
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
