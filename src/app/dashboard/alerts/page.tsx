"use client";

import { useEffect, useState } from "react";
import { useSelectedEndpointId } from "@/components/dashboard/use-endpoint";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { loadEndpoints } from "@/lib/frontend-mock";

type AlertRow = {
  id: string;
  endpoint_id: string;
  message: string;
  severity: "low" | "medium" | "high";
  created_at: string;
};

type HealRow = {
  id: string;
  endpoint_id: string;
  action_taken: string;
  status: "success" | "failure";
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

function readSelectedEndpoint() {
  if (typeof window === "undefined") return null;
  const id = localStorage.getItem("kubepulse.endpointId");
  if (!id) return null;
  const ep = loadEndpoints().find((e) => e.id === id);
  if (!ep) return null;
  return ep;
}

function sevClass(s: AlertRow["severity"]) {
  if (s === "high") return "text-rose-300";
  if (s === "medium") return "text-amber-300";
  return "text-emerald-300";
}

export default function AlertsPage() {
  const endpointId = useSelectedEndpointId();
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [heals, setHeals] = useState<HealRow[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!endpointId) {
      setAlerts([]);
      setFetchError(null);
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const selected = readSelectedEndpoint();
      if (!selected) return;

      try {
        const u = new URL("/api/dashboard/pods", window.location.origin);
        u.searchParams.set("ngrok_url", selected.ngrok_url);
        const res = await fetch(u.toString(), { cache: "no-store" });
        const data = (await res.json()) as {
          error?: string;
          pods?: UpstreamPod[];
          fetched_at?: string;
        };
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        if (!Array.isArray(data.pods)) throw new Error("Invalid response: missing pods");

        const createdAt = data.fetched_at ?? new Date().toISOString();
        const nextAlerts = data.pods
          .filter((p) => !p.status.toLowerCase().includes("running") || (p.restart_count ?? 0) > 2)
          .slice(0, 24)
          .map((p) => ({
            id: crypto.randomUUID(),
            endpoint_id: selected.id,
            message: `${p.namespace ?? "default"}/${p.pod_name} ${p.status} (restarts=${p.restart_count ?? 0})`,
            severity: p.status.toLowerCase().includes("running") ? "medium" : "high",
            created_at: createdAt,
          })) as AlertRow[];

        if (!cancelled) {
          setAlerts(nextAlerts);
          setFetchError(null);
          setHeals([]);
        }
      } catch (e) {
        if (!cancelled) {
          setFetchError(e instanceof Error ? e.message : String(e));
        }
      }
    };

    void poll();
    const id = setInterval(() => {
      void poll();
    }, 6000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [endpointId]);

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
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <div className="text-lg font-semibold">Alerts</div>
          <div className="text-sm text-zinc-400">
            Frontend mock alert stream.
          </div>
        </CardHeader>
        <CardBody>
          {fetchError ? (
            <div className="mb-2 text-sm text-rose-300">Could not load alerts: {fetchError}</div>
          ) : null}
          <div className="space-y-2">
            {alerts.map((a) => (
              <div key={a.id} className="rounded-lg border border-white/10 bg-black/10 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className={cn("text-xs font-semibold uppercase", sevClass(a.severity))}>
                    {a.severity}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {new Date(a.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="mt-1 text-sm text-zinc-200">{a.message}</div>
              </div>
            ))}
            {!alerts.length ? (
              <div className="text-sm text-zinc-400">No alerts yet.</div>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="text-lg font-semibold">Self-healing insights</div>
          <div className="text-sm text-zinc-400">
            No fake events are shown. Wire your healing agent to /api/healing-actions to see real actions.
          </div>
        </CardHeader>
        <CardBody>
          <div className="space-y-2">
            {heals.map((h) => (
              <div key={h.id} className="rounded-lg border border-white/10 bg-black/10 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div
                    className={cn(
                      "text-xs font-semibold uppercase",
                      h.status === "success" ? "text-emerald-300" : "text-rose-300",
                    )}
                  >
                    {h.status}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {new Date(h.timestamp).toLocaleString()}
                  </div>
                </div>
                <div className="mt-1 text-sm text-zinc-200">{h.action_taken}</div>
              </div>
            ))}
            {!heals.length ? (
              <div className="text-sm text-zinc-400">No healing actions yet.</div>
            ) : null}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

