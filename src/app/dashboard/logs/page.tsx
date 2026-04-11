"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSelectedEndpointId } from "@/components/dashboard/use-endpoint";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loadEndpoints } from "@/lib/frontend-mock";

type UpstreamPod = {
  pod_name: string;
  namespace?: string;
};

function readSelectedEndpoint() {
  if (typeof window === "undefined") return null;
  const id = localStorage.getItem("kubepulse.endpointId");
  if (!id) return null;
  const ep = loadEndpoints().find((e) => e.id === id);
  if (!ep) return null;
  return ep;
}

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
      const selected = readSelectedEndpoint();
      if (!selected) return;
      try {
        const u = new URL("/api/dashboard/pods", window.location.origin);
        u.searchParams.set("ngrok_url", selected.ngrok_url);
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
      const selected = readSelectedEndpoint();
      if (!selected) throw new Error("Selected endpoint not found");

      const u = new URL("/api/logs", window.location.origin);
      u.searchParams.set("ngrok_url", selected.ngrok_url);
      u.searchParams.set("pod", pod);
      u.searchParams.set("namespace", namespace);

      const res = await fetch(u.toString(), { cache: "no-store" });
      const data = (await res.json()) as { error?: string; logs?: string };
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setLogs(data.logs || "");
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
            Live pod logs from your selected ngrok endpoint.
          </div>
        </CardHeader>
        <CardBody className="space-y-3">
          {fetchError ? (
            <div className="text-sm text-rose-300">Could not load logs: {fetchError}</div>
          ) : null}
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

