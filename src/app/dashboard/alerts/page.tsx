"use client";

import { useEffect, useState } from "react";
import { useSelectedEndpointId } from "@/components/dashboard/use-endpoint";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { readSelectedEndpoint } from "@/lib/endpoints-client";

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
  if (s === "high") return "text-danger";
  if (s === "medium") return "text-accent";
  return "text-ok";
}

export default function AlertsPage() {
  const endpointId = useSelectedEndpointId();
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [heals, setHeals] = useState<HealRow[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!endpointId) {
      setAlerts([]);
      setHeals([]);
      setFetchError(null);
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const selected = await readSelectedEndpoint();
      if (!selected) return;

      try {
        const u = new URL("/api/alerts", window.location.origin);
        u.searchParams.set("endpoint", selected.id);
        const res = await fetch(u.toString(), { cache: "no-store" });
        const data = (await res.json()) as {
          error?: string;
          alerts?: AlertRow[];
          healing_actions?: HealRow[];
        };
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        if (!Array.isArray(data.alerts)) throw new Error("Invalid response: missing alerts");
        if (!Array.isArray(data.healing_actions)) {
          throw new Error("Invalid response: missing healing actions");
        }

        if (!cancelled) {
          setAlerts(data.alerts);
          setHeals(data.healing_actions);
          setFetchError(null);
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
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Select an endpoint</div>
          <div className="text-sm text-muted">Use the top bar selector.</div>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Alerts</div>
          <div className="text-sm text-muted">
            Real alerts recorded by backend polling.
          </div>
        </CardHeader>
        <CardBody>
          {fetchError ? (
            <div className="mb-2 text-sm text-danger">Could not load alerts: {fetchError}</div>
          ) : null}
          <div className="space-y-3">
            {alerts.map((a) => (
              <div key={a.id} className="rounded-2xl bg-[#fffdf8] p-4 shadow-[0_10px_22px_rgba(70,86,94,0.09)]">
                <div className="flex items-center justify-between gap-2">
                  <div className={cn("rounded-full bg-[#f4eee4] px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.12em]", sevClass(a.severity))}>
                    {a.severity}
                  </div>
                  <div className="text-xs text-[#7d8893]">
                    {new Date(a.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="mt-2 text-sm text-[#2f3c46]">{a.message}</div>
              </div>
            ))}
            {!alerts.length ? (
              <div className="text-sm text-muted">No alerts yet.</div>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Self-healing insights</div>
          <div className="text-sm text-muted">
            No fake events are shown. Wire your healing agent to /api/healing-actions to see real actions.
          </div>
        </CardHeader>
        <CardBody>
          <div className="space-y-3">
            {heals.map((h) => (
              <div key={h.id} className="rounded-2xl bg-[#fffdf8] p-4 shadow-[0_10px_22px_rgba(70,86,94,0.09)]">
                <div className="flex items-center justify-between gap-2">
                  <div
                    className={cn(
                      "rounded-full bg-[#f4eee4] px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.12em]",
                      h.status === "success" ? "text-ok" : "text-danger",
                    )}
                  >
                    {h.status}
                  </div>
                  <div className="text-xs text-[#7d8893]">
                    {new Date(h.timestamp).toLocaleString()}
                  </div>
                </div>
                <div className="mt-2 text-sm text-[#2f3c46]">{h.action_taken}</div>
              </div>
            ))}
            {!heals.length ? (
              <div className="text-sm text-muted">No healing actions yet.</div>
            ) : null}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

