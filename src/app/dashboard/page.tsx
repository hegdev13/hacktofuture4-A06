"use client";

import { useEffect, useMemo, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatBytes, formatNumber } from "@/lib/format";
import { useSelectedEndpointId } from "@/components/dashboard/use-endpoint";
import { initialSnapshots, tickSnapshots, type SnapshotRow } from "@/lib/frontend-mock";

function statusColor(status: string) {
  const s = status.toLowerCase();
  if (s.includes("running") || s === "ok") return "text-emerald-300";
  if (s.includes("pending")) return "text-amber-300";
  if (s.includes("crashloop") || s.includes("error") || s.includes("failed")) return "text-rose-300";
  return "text-zinc-300";
}

export default function DashboardOverviewPage() {
  const endpointId = useSelectedEndpointId();
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!endpointId) return;
    setLoading(true);
    setRows(initialSnapshots(endpointId).slice(0, 400));
    setLoading(false);
    const id = setInterval(() => {
      setRows(tickSnapshots(endpointId).slice(0, 400));
    }, 4000);
    return () => clearInterval(id);
  }, [endpointId]);

  const latestByPod = useMemo(() => {
    const map = new Map<string, SnapshotRow>();
    for (const r of rows) {
      const key = `${r.namespace}/${r.pod_name}`;
      if (!map.has(key)) map.set(key, r);
    }
    return Array.from(map.values()).slice(0, 50);
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

  const timeseries = useMemo(() => {
    const byTs = new Map<string, { ts: string; cpu: number; mem: number; pods: number }>();
    for (const r of rows) {
      const ts = new Date(r.timestamp).toISOString().slice(0, 19) + "Z";
      const cur = byTs.get(ts) || { ts, cpu: 0, mem: 0, pods: 0 };
      cur.pods += 1;
      cur.cpu += typeof r.cpu_usage === "number" ? r.cpu_usage : 0;
      cur.mem += typeof r.memory_usage === "number" ? r.memory_usage : 0;
      byTs.set(ts, cur);
    }
    return Array.from(byTs.values())
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .slice(-120)
      .map((p) => ({
        ts: p.ts.slice(11, 19),
        cpu: p.pods ? p.cpu / p.pods : 0,
        mem: p.pods ? p.mem / p.pods : 0,
      }));
  }, [rows]);

  if (!endpointId) {
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
            <div className="font-semibold">CPU usage (avg over pods)</div>
            <div className="text-xs text-zinc-400">Frontend mock realtime stream</div>
          </CardHeader>
          <CardBody className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timeseries}>
                <XAxis dataKey="ts" tick={{ fill: "#9CA3AF", fontSize: 12 }} />
                <YAxis tick={{ fill: "#9CA3AF", fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    background: "#0B1220",
                    border: "1px solid rgba(255,255,255,0.1)",
                    color: "#E5E7EB",
                    fontSize: 12,
                  }}
                />
                <Line type="monotone" dataKey="cpu" stroke="#6366F1" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="font-semibold">Memory usage (avg over pods)</div>
            <div className="text-xs text-zinc-400">Bytes (or upstream units)</div>
          </CardHeader>
          <CardBody className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timeseries}>
                <XAxis dataKey="ts" tick={{ fill: "#9CA3AF", fontSize: 12 }} />
                <YAxis tick={{ fill: "#9CA3AF", fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    background: "#0B1220",
                    border: "1px solid rgba(255,255,255,0.1)",
                    color: "#E5E7EB",
                    fontSize: 12,
                  }}
                />
                <Line type="monotone" dataKey="mem" stroke="#22C55E" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="font-semibold">Pod health</div>
          <div className="text-xs text-zinc-400">
            Latest status per pod {loading ? "(loading…)" : ""}
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
                    <td className={cn("py-2 font-medium", statusColor(r.status))}>
                      {r.status}
                    </td>
                    <td className="py-2 text-zinc-300">{r.restart_count}</td>
                  </tr>
                ))}
                {!latestByPod.length ? (
                  <tr>
                    <td className="py-4 text-zinc-400" colSpan={4}>
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

