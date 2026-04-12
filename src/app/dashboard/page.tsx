"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatBytes, formatNumber } from "@/lib/format";
import {
  readSelectedEndpoint as readSelectedEndpointFromApi,
  type Endpoint,
} from "@/lib/endpoints-client";

type SnapshotRow = {
  id: string;
  endpoint_id: string;
  pod_name: string;
  namespace: string;
  status: string;
  cpu_usage: number | null;
  memory_usage: number | null;
  restart_count: number;
  timestamp: string;
};

function statusColor(status: string) {
  const s = status.toLowerCase();
  if (s.includes("running") || s === "ok") return "text-ok";
  if (s.includes("pending")) return "text-accent";
  if (s.includes("crashloop") || s.includes("error") || s.includes("failed")) return "text-danger";
  return "text-[#4f5d68]";
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
  const [selectedEp, setSelectedEp] = useState<Endpoint | null>(null);

  const poll = useCallback(async () => {
    try {
      const sel = await readSelectedEndpointFromApi();
      setSelectedEp(sel);
      if (!sel) {
        setRows([]);
        setFetchError(null);
        return;
      }

      setLoading(true);
      setFetchError(null);

      const u = new URL("/api/dashboard/pods", window.location.origin);
      u.searchParams.set("endpoint", sel.id);
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
      void poll();
    };
    void poll();
    setUiReady(true);
    const id = setInterval(() => {
      void poll();
    }, 4000);
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
          <div className="text-sm text-muted">Loading dashboard...</div>
        </CardBody>
      </Card>
    );
  }

  if (!selectedEp) {
    return (
      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">No endpoint selected</div>
          <div className="text-sm text-muted">
            Add an ngrok endpoint in Setup, then select it from the top bar.
          </div>
        </CardHeader>
        <CardBody>
          <a className="font-semibold text-primary-strong hover:text-primary" href="/dashboard/setup">
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
            <div className="text-sm text-danger">Could not load cluster: {fetchError}</div>
            <div className="mt-1 text-xs text-[#7d8893]">
              Check that the saved ngrok base URL matches your tunnel (HTTPS) and exposes{" "}
              <code className="text-[#4f5d68]">/pods</code> or a metrics path.
            </div>
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardBody>
            <div className="text-xs text-muted">Total pods</div>
            <div className="mt-1 text-2xl font-semibold">{cluster.totalPods}</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs text-muted">Running / Failed / Pending</div>
            <div className="mt-1 text-2xl font-semibold">
              {cluster.running}
              <span className="text-[#8a949d]"> / </span>
              <span className="text-danger">{cluster.failed}</span>
              <span className="text-[#8a949d]"> / </span>
              <span className="text-accent">{cluster.pending}</span>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs text-muted">Avg CPU (raw)</div>
            <div className="mt-1 text-2xl font-semibold">
              {cluster.avgCpu == null ? "—" : formatNumber(cluster.avgCpu)}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs text-muted">Avg Memory</div>
            <div className="mt-1 text-2xl font-semibold">
              {cluster.avgMem == null ? "—" : formatBytes(cluster.avgMem)}
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="text-xl font-bold tracking-tight text-[#1f2b33]">Pod counts (poll history)</div>
            <div className="text-xs text-muted">Live data from your ngrok base URL</div>
          </CardHeader>
          <CardBody className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={podCountSeries}>
                <XAxis dataKey="tsLabel" tick={{ fill: "#6f7a84", fontSize: 12 }} />
                <YAxis tick={{ fill: "#6f7a84", fontSize: 12 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: "#fff9f0",
                    border: "1px solid #e7ddcd",
                    color: "#2f3a42",
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="total" name="Total" stroke="#4e8f9b" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="running" name="Running" stroke="#5a9b7d" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-xl font-bold tracking-tight text-[#1f2b33]">CPU &amp; memory (avg over pods)</div>
            <div className="text-xs text-muted">
              {hasResourceMetrics
                ? "Values from upstream when pods include cpu_usage / memory_usage"
                : "Your /pods payload has no per-pod CPU or memory; add those fields for this chart"}
            </div>
          </CardHeader>
          <CardBody className="h-56">
            {hasResourceMetrics ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={resourceSeries}>
                  <XAxis dataKey="tsLabel" tick={{ fill: "#6f7a84", fontSize: 12 }} />
                  <YAxis tick={{ fill: "#6f7a84", fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      background: "#fff9f0",
                      border: "1px solid #e7ddcd",
                      color: "#2f3a42",
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="cpu" name="CPU (avg)" stroke="#4e8f9b" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="mem" name="Mem (bytes)" stroke="#db8a52" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted">
                No resource samples yet — table and pod counts above are live.
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="text-xl font-bold tracking-tight text-[#1f2b33]">Pod health</div>
          <div className="text-xs text-muted">
            Latest status per pod from upstream {loading ? "(refreshing…)" : ""}
          </div>
        </CardHeader>
        <CardBody>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="text-xs text-muted">
                <tr className="border-b border-[#ede3d3]">
                  <th className="py-2 text-left font-medium">Pod</th>
                  <th className="py-2 text-left font-medium">Namespace</th>
                  <th className="py-2 text-left font-medium">Status</th>
                  <th className="py-2 text-left font-medium">Restarts</th>
                </tr>
              </thead>
              <tbody>
                {latestByPod.map((r) => (
                  <tr key={`${r.namespace}/${r.pod_name}`} className="border-b border-[#f0e7d9]">
                    <td className="py-2 font-semibold text-[#27343d]">{r.pod_name}</td>
                    <td className="py-2 text-[#4f5d68]">{r.namespace}</td>
                    <td className={cn("py-2 font-medium", statusColor(r.status))}>{r.status}</td>
                    <td className="py-2 text-[#4f5d68]">{r.restart_count}</td>
                  </tr>
                ))}
                {!latestByPod.length && !fetchError ? (
                  <tr>
                    <td className="py-4 text-muted" colSpan={4}>
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
