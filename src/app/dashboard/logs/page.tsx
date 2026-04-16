"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSelectedEndpointId } from "@/components/dashboard/use-endpoint";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readSelectedEndpoint } from "@/lib/endpoints-client";

type UpstreamPod = {
  pod_name: string;
  namespace?: string;
};

type QueriedLogRow = {
  id: string;
  timestamp: string;
  message: string;
  level: string;
  source: string;
  labels?: Record<string, string>;
};

export default function LogsPage() {
  const endpointId = useSelectedEndpointId();
  const [pods, setPods] = useState<Array<{ pod_name: string; namespace: string }>>(
    [],
  );
  const [pod, setPod] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [logs, setLogs] = useState("");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);

  useEffect(() => {
    if (!endpointId) {
      setPods([]);
      setFetchError(null);
      return;
    }

    let cancelled = false;
    const loadPods = async () => {
      try {
        const selected = await readSelectedEndpoint();
        if (!selected) return;

        const u = new URL("/api/dashboard/pods", window.location.origin);
        u.searchParams.set("endpoint", selected.id);
        const res = await fetch(u.toString(), { cache: "no-store" });
        const data = (await res.json()) as {
          error?: string;
          pods?: UpstreamPod[];
        };
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        if (!Array.isArray(data.pods)) throw new Error("Invalid response: missing pods");

        const seen = new Set<string>();
        const out: Array<{ pod_name: string; namespace: string }> = [];
        for (const p of data.pods) {
          const ns = p.namespace ?? "default";
          const key = `${ns}/${p.pod_name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ pod_name: p.pod_name, namespace: ns });
        }

        if (!cancelled) {
          setPods(out);
          if (!pod && out.length) {
            setPod(out[0].pod_name);
            setNamespace(out[0].namespace);
          }
          setFetchError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setFetchError(e instanceof Error ? e.message : String(e));
        }
      }
    };

    void loadPods();
    const id = setInterval(() => {
      void loadPods();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [endpointId, pod]);

  const podOptions = useMemo(() => pods, [pods]);

  const fetchLogs = useCallback(async () => {
    if (!endpointId || !pod) return;
    setLoading(true);
    try {
      const selected = await readSelectedEndpoint();
      if (!selected) throw new Error("Selected endpoint not found");

      const queryUrl = new URL("/api/logs/query", window.location.origin);
      queryUrl.searchParams.set("endpoint", selected.id);
      queryUrl.searchParams.set("pod", pod);
      queryUrl.searchParams.set("namespace", namespace);
      queryUrl.searchParams.set("limit", "500");

      const queryRes = await fetch(queryUrl.toString(), { cache: "no-store" });
      const queryData = (await queryRes.json()) as { error?: string; logs?: QueriedLogRow[] };

      if (queryRes.ok && Array.isArray(queryData.logs) && queryData.logs.length > 0) {
        const rendered = queryData.logs
          .slice()
          .reverse()
          .map((row) => {
            const ts = new Date(row.timestamp).toLocaleTimeString();
            const ns = row.labels?.namespace ?? namespace;
            const p = row.labels?.pod ?? pod;
            return `[${ts}] [${row.level}] [${row.source}] [${ns}/${p}] ${row.message}`;
          })
          .join("\n");
        setLogs(rendered);
      } else {
        const u = new URL("/api/logs", window.location.origin);
        u.searchParams.set("endpoint", selected.id);
        u.searchParams.set("pod", pod);
        u.searchParams.set("namespace", namespace);

        const res = await fetch(u.toString(), { cache: "no-store" });
        const data = (await res.json()) as { error?: string; logs?: string };
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        setLogs(data.logs || "");
      }

      setFetchError(null);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
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
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Select an endpoint</div>
          <div className="text-sm text-muted">Use the top bar selector.</div>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Logs viewer</div>
          <div className="text-sm text-muted">
            Live pod logs from your selected ngrok endpoint.
          </div>
        </CardHeader>
        <CardBody className="space-y-3">
          {fetchError ? (
            <div className="text-sm text-danger">Could not load logs: {fetchError}</div>
          ) : null}
          <div className="grid gap-3 md:grid-cols-3">
            <label className="block">
              <div className="mb-2 text-sm font-semibold text-[#2d3942]">Pod</div>
              <select
                value={`${namespace}/${pod}`}
                onChange={(e) => {
                  const [ns, p] = e.target.value.split("/");
                  setNamespace(ns);
                  setPod(p);
                }}
                className="w-full rounded-xl border border-[#e8ddcc] bg-[#fffdf8] px-4 py-2.5 text-sm text-[#22303a] focus:outline-none focus:ring-2 focus:ring-primary/35"
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
              <label className="flex items-center gap-2 text-sm text-[#4f5e69]">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                />
                Auto-refresh
              </label>
            </div>
          </div>

          <pre className="max-h-[60vh] overflow-auto rounded-2xl border border-[#e6dccb] bg-[#f2ece3] p-4 font-mono text-xs leading-6 text-[#34424d] shadow-[0_12px_24px_rgba(70,86,94,0.09)]">
            {logs || "No logs loaded yet."}
          </pre>
        </CardBody>
      </Card>
    </div>
  );
}

