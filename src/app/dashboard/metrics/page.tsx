"use client";

import { useEffect, useMemo, useState } from "react";
import { useSelectedEndpointId } from "@/components/dashboard/use-endpoint";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatBytes, formatNumber } from "@/lib/format";
import { initialSnapshots, tickSnapshots, type SnapshotRow } from "@/lib/frontend-mock";

export default function MetricsPage() {
  const endpointId = useSelectedEndpointId();
  const [rows, setRows] = useState<SnapshotRow[]>([]);

  useEffect(() => {
    if (!endpointId) return;
    setRows(initialSnapshots(endpointId).slice(0, 800));
    const id = setInterval(() => setRows(tickSnapshots(endpointId).slice(0, 800)), 4000);
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

  if (!endpointId) {
    return (
      <Card>
        <CardHeader>
          <div className="text-lg font-semibold">Select an endpoint</div>
          <div className="text-sm text-zinc-400">Use the top bar selector.</div>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="text-lg font-semibold">Pod metrics</div>
          <div className="text-sm text-zinc-400">
            Latest snapshot per pod (CPU + memory values are upstream-dependent).
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
                  <th className="py-2 text-left font-medium">CPU</th>
                  <th className="py-2 text-left font-medium">Memory</th>
                  <th className="py-2 text-left font-medium">Restarts</th>
                </tr>
              </thead>
              <tbody>
                {latestByPod.map((r) => (
                  <tr key={`${r.namespace}/${r.pod_name}`} className="border-b border-white/5">
                    <td className="py-2 font-medium">{r.pod_name}</td>
                    <td className="py-2 text-zinc-300">{r.namespace}</td>
                    <td className="py-2 text-zinc-300">{r.status}</td>
                    <td className="py-2 text-zinc-300">
                      {r.cpu_usage == null ? "—" : formatNumber(r.cpu_usage)}
                    </td>
                    <td className="py-2 text-zinc-300">
                      {r.memory_usage == null ? "—" : formatBytes(r.memory_usage)}
                    </td>
                    <td className="py-2 text-zinc-300">{r.restart_count}</td>
                  </tr>
                ))}
                {!latestByPod.length ? (
                  <tr>
                    <td className="py-4 text-zinc-400" colSpan={6}>
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

