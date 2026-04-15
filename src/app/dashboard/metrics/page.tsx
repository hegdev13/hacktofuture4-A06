"use client";

import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useSelectedEndpointId } from "@/components/dashboard/use-endpoint";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatBytes, formatNumber } from "@/lib/format";
import { readSelectedEndpoint } from "@/lib/endpoints-client";

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

type UpstreamPod = {
  pod_name: string;
  namespace?: string;
  status: string;
  cpu_usage?: number | null;
  memory_usage?: number | null;
  restart_count?: number | null;
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

export default function MetricsPage() {
  const endpointId = useSelectedEndpointId();
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!endpointId) {
      setRows([]);
      setFetchError(null);
      return;
    }

    const poll = async () => {
      try {
        const selected = await readSelectedEndpoint();
        if (!selected) {
          setRows([]);
          setFetchError("Selected endpoint not found");
          return;
        }

        const u = new URL("/api/dashboard/pods", window.location.origin);
        u.searchParams.set("endpoint", selected.id);
        const res = await fetch(u.toString(), { cache: "no-store" });
        const data = (await res.json()) as {
          error?: string;
          pods?: UpstreamPod[];
          fetched_at?: string;
        };
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        if (!Array.isArray(data.pods)) throw new Error("Invalid response: missing pods");
        setRows(podsToRows(selected.id, data.pods, data.fetched_at ?? new Date().toISOString()).slice(0, 800));
        setFetchError(null);
      } catch (e) {
        setFetchError(e instanceof Error ? e.message : String(e));
      }
    };

    void poll();
    const id = setInterval(() => {
      void poll();
    }, 4000);
    return () => clearInterval(id);
  }, [endpointId]);

  const latestByPod = useMemo(() => {
    const map = new Map<string, SnapshotRow>();
    for (const r of rows) {
      const key = `${r.namespace}/${r.pod_name}`;
      if (!map.has(key)) map.set(key, r);
    }
    return Array.from(map.values()).slice(0, 120);
  }, [rows]);

  const statusDist = useMemo(() => {
    let running = 0;
    let pending = 0;
    let failed = 0;
    let other = 0;
    for (const r of latestByPod) {
      const s = r.status.toLowerCase();
      if (s.includes("running")) running += 1;
      else if (s.includes("pending")) pending += 1;
      else if (s.includes("crashloop") || s.includes("error") || s.includes("failed")) failed += 1;
      else other += 1;
    }
    return [
      { name: "Running", value: running, fill: "#5a9b7d" },
      { name: "Pending", value: pending, fill: "#db8a52" },
      { name: "Failed", value: failed, fill: "#ca5a58" },
      { name: "Other", value: other, fill: "#8a97a1" },
    ].filter((item) => item.value > 0);
  }, [latestByPod]);

  const restartTop = useMemo(() => {
    return [...latestByPod]
      .sort((a, b) => b.restart_count - a.restart_count)
      .slice(0, 8)
      .map((r) => ({
        pod: r.pod_name.length > 20 ? `${r.pod_name.slice(0, 20)}...` : r.pod_name,
        restarts: r.restart_count,
      }));
  }, [latestByPod]);

  if (!endpointId) {
    return (
      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Select an endpoint</div>
          <div className="text-sm text-muted">Use the top bar selector.</div>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {fetchError ? (
        <Card>
          <CardBody>
            <div className="text-sm text-danger">Could not load metrics: {fetchError}</div>
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Pod Status Distribution</div>
            <div className="text-sm text-muted">Live breakdown from current snapshot.</div>
          </CardHeader>
          <CardBody className="h-64">
            {statusDist.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={statusDist} dataKey="value" nameKey="name" outerRadius={90} label />
                  <Tooltip
                    contentStyle={{
                      background: "#fff9f0",
                      border: "1px solid #e7ddcd",
                      color: "#2f3a42",
                      fontSize: 12,
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-sm text-muted">No status data yet.</div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Top Restarting Pods</div>
            <div className="text-sm text-muted">Highest restart_count pods right now.</div>
          </CardHeader>
          <CardBody className="h-64">
            {restartTop.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={restartTop} layout="vertical" margin={{ left: 10, right: 10, top: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(90,107,118,0.15)" />
                  <XAxis type="number" tick={{ fill: "#6f7a84", fontSize: 12 }} allowDecimals={false} />
                  <YAxis type="category" dataKey="pod" width={150} tick={{ fill: "#6f7a84", fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      background: "#fff9f0",
                      border: "1px solid #e7ddcd",
                      color: "#2f3a42",
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="restarts" fill="#db8a52" radius={[0, 8, 8, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-sm text-muted">No restart data yet.</div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Pod metrics</div>
          <div className="text-sm text-muted">
            Live snapshot per pod from your selected ngrok endpoint.
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
                  <th className="py-2 text-left font-medium">CPU</th>
                  <th className="py-2 text-left font-medium">Memory</th>
                  <th className="py-2 text-left font-medium">Restarts</th>
                </tr>
              </thead>
              <tbody>
                {latestByPod.map((r) => (
                  <tr key={`${r.namespace}/${r.pod_name}`} className="border-b border-[#f0e7d9]">
                    <td className="py-2 font-semibold text-[#27343d]">{r.pod_name}</td>
                    <td className="py-2 text-[#4f5d68]">{r.namespace}</td>
                    <td className="py-2 text-[#4f5d68]">{r.status}</td>
                    <td className="py-2 text-[#4f5d68]">
                      {r.cpu_usage == null ? "—" : formatNumber(r.cpu_usage)}
                    </td>
                    <td className="py-2 text-[#4f5d68]">
                      {r.memory_usage == null ? "—" : formatBytes(r.memory_usage)}
                    </td>
                    <td className="py-2 text-[#4f5d68]">{r.restart_count}</td>
                  </tr>
                ))}
                {!latestByPod.length ? (
                  <tr>
                    <td className="py-4 text-muted" colSpan={6}>
                      No snapshots yet.
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

