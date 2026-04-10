"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSelectedEndpointId } from "@/components/dashboard/use-endpoint";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { initialSnapshots, tickSnapshots, type SnapshotRow } from "@/lib/frontend-mock";

export default function LogsPage() {
  const endpointId = useSelectedEndpointId();
  const [pods, setPods] = useState<Array<{ pod_name: string; namespace: string }>>(
    [],
  );
  const [pod, setPod] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);

  useEffect(() => {
    if (!endpointId) return;
    const seen = new Set<string>();
    const out: Array<{ pod_name: string; namespace: string }> = [];
    for (const r of initialSnapshots(endpointId).slice(0, 250) as SnapshotRow[]) {
      const key = `${r.namespace}/${r.pod_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pod_name: r.pod_name, namespace: r.namespace });
    }
    setPods(out);
    if (!pod && out.length) {
      setPod(out[0].pod_name);
      setNamespace(out[0].namespace);
    }
  }, [endpointId, pod]);

  const podOptions = useMemo(() => pods, [pods]);

  const fetchLogs = useCallback(async () => {
    if (!endpointId || !pod) return;
    setLoading(true);
    try {
      const rows = tickSnapshots(endpointId).filter(
        (r) => r.pod_name === pod && r.namespace === namespace,
      );
      const lines = rows.slice(0, 25).map((r, i) => {
        return `${new Date(r.timestamp).toISOString()} [${namespace}/${pod}] status=${r.status} cpu=${r.cpu_usage ?? "n/a"} mem=${r.memory_usage ?? "n/a"} restarts=${r.restart_count} msg=Mock line ${i + 1}`;
      });
      setLogs(lines.join("\n"));
    } finally {
      setLoading(false);
    }
  }, [endpointId, namespace, pod]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      fetchLogs().catch(() => {});
    }, 4000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchLogs]);

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
          <div className="text-lg font-semibold">Logs viewer</div>
          <div className="text-sm text-zinc-400">
            Frontend mock logs viewer (no backend).
          </div>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="block">
              <div className="mb-1 text-sm font-medium text-zinc-200">Pod</div>
              <select
                value={`${namespace}/${pod}`}
                onChange={(e) => {
                  const [ns, p] = e.target.value.split("/");
                  setNamespace(ns);
                  setPod(p);
                }}
                className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
              >
                {podOptions.map((p) => (
                  <option key={`${p.namespace}/${p.pod_name}`} value={`${p.namespace}/${p.pod_name}`}>
                    {p.namespace}/{p.pod_name}
                  </option>
                ))}
              </select>
            </label>
            <Input
              label="Namespace"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              placeholder="default"
            />
            <div className="flex items-end gap-2">
              <Button onClick={() => fetchLogs()} disabled={loading || !pod}>
                {loading ? "Loading..." : "Fetch logs"}
              </Button>
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  className="accent-indigo-400"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                />
                Auto-refresh
              </label>
            </div>
          </div>

          <pre className="max-h-[60vh] overflow-auto rounded-lg border border-white/10 bg-black/30 p-3 text-xs leading-5 text-zinc-200">
            {logs || "No logs loaded yet."}
          </pre>
        </CardBody>
      </Card>
    </div>
  );
}

