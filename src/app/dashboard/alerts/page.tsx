"use client";

import { useEffect, useState } from "react";
import { useSelectedEndpointId } from "@/components/dashboard/use-endpoint";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { initialSnapshots, tickSnapshots } from "@/lib/frontend-mock";

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

function sevClass(s: AlertRow["severity"]) {
  if (s === "high") return "text-rose-300";
  if (s === "medium") return "text-amber-300";
  return "text-emerald-300";
}

export default function AlertsPage() {
  const endpointId = useSelectedEndpointId();
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [heals, setHeals] = useState<HealRow[]>([]);

  useEffect(() => {
    if (!endpointId) return;
    const base = initialSnapshots(endpointId).slice(0, 50);
    setAlerts(
      base
        .filter((r) => r.status !== "Running" || r.restart_count > 2)
        .slice(0, 12)
        .map((r) => ({
          id: r.id,
          endpoint_id: endpointId,
          message: `${r.namespace}/${r.pod_name} ${r.status} (restarts=${r.restart_count})`,
          severity: r.status === "Running" ? "medium" : "high",
          created_at: r.timestamp,
        })),
    );
    setHeals([
      {
        id: crypto.randomUUID(),
        endpoint_id: endpointId,
        action_taken: "Restarted cartservice deployment",
        status: "success",
        timestamp: new Date().toISOString(),
      },
    ]);
    const id = setInterval(() => {
      const fresh = tickSnapshots(endpointId).slice(0, 8);
      const nextAlerts = fresh
        .filter((r) => r.status !== "Running" || r.restart_count > 2)
        .map((r) => ({
          id: crypto.randomUUID(),
          endpoint_id: endpointId,
          message: `${r.namespace}/${r.pod_name} ${r.status} (restarts=${r.restart_count})`,
          severity: r.status === "Running" ? "medium" : "high",
          created_at: r.timestamp,
        })) as AlertRow[];
      if (nextAlerts.length) {
        setAlerts((prev) => [...nextAlerts, ...prev].slice(0, 100));
      }
      setHeals((prev) => [
        {
          id: crypto.randomUUID(),
          endpoint_id: endpointId,
          action_taken: "Suggested fix: restart failing pod and scale deployment x2",
          status: Math.random() > 0.2 ? "success" : "failure",
          timestamp: new Date().toISOString(),
        },
        ...prev,
      ].slice(0, 100));
    }, 6000);
    return () => clearInterval(id);
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
            Timeline of mocked self-healing actions.
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

