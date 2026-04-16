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

type AlertStateRow = {
  rule_key: string;
  state: "pending" | "firing" | "resolved";
  state_since: string;
  last_value: number | null;
  updated_at: string;
};

type AlertHistoryRow = {
  id: string;
  rule_key: string;
  state: "pending" | "firing" | "resolved";
  value: number | null;
  message: string;
  timestamp: string;
};

function sevClass(severity: AlertRow["severity"]) {
  if (severity === "high") return "text-danger";
  if (severity === "medium") return "text-accent";
  return "text-ok";
}

export default function AlertsPage() {
  const endpointId = useSelectedEndpointId();
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [heals, setHeals] = useState<HealRow[]>([]);
  const [alertStates, setAlertStates] = useState<AlertStateRow[]>([]);
  const [alertHistory, setAlertHistory] = useState<AlertHistoryRow[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!endpointId) {
      setAlerts([]);
      setHeals([]);
      setAlertStates([]);
      setAlertHistory([]);
      setFetchError(null);
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const selected = await readSelectedEndpoint();
      if (!selected) return;

      try {
        const url = new URL("/api/alerts", window.location.origin);
        url.searchParams.set("endpoint", selected.id);
        const response = await fetch(url.toString(), { cache: "no-store" });
        const data = (await response.json()) as {
          error?: string;
          alerts?: AlertRow[];
          healing_actions?: HealRow[];
          alert_states?: AlertStateRow[];
          alert_history?: AlertHistoryRow[];
        };

        if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
        if (!Array.isArray(data.alerts)) throw new Error("Invalid response: missing alerts");
        if (!Array.isArray(data.healing_actions)) throw new Error("Invalid response: missing healing actions");

        if (!cancelled) {
          setAlerts(data.alerts);
          setHeals(data.healing_actions);
          setAlertStates(Array.isArray(data.alert_states) ? data.alert_states : []);
          setAlertHistory(Array.isArray(data.alert_history) ? data.alert_history.slice(0, 12) : []);
          setFetchError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setFetchError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    void poll();
    const intervalId = window.setInterval(() => {
      void poll();
    }, 6000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
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
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Alerts & Healing</div>
          <div className="text-sm text-muted">Live alert states and healing actions. Cost UI has been removed.</div>
        </CardHeader>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Alerts</div>
            <div className="text-sm text-muted">Real alerts recorded by backend polling.</div>
          </CardHeader>
          <CardBody>
            {fetchError ? <div className="mb-2 text-sm text-danger">Could not load alerts: {fetchError}</div> : null}
            <div className="space-y-3">
              {alertStates.length ? (
                <div className="rounded-2xl border border-[#eadfce] bg-[#fffcf6] p-3 text-xs text-[#50606c]">
                  <div className="mb-2 font-semibold text-[#2f3c46]">Current rule states</div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {alertStates.slice(0, 6).map((stateRow) => (
                      <div key={`${stateRow.rule_key}-${stateRow.updated_at}`} className="rounded-xl bg-[#fff9ef] px-3 py-2">
                        <div className="font-medium text-[#2f3c46]">{stateRow.rule_key}</div>
                        <div
                          className={cn(
                            "uppercase tracking-[0.1em]",
                            stateRow.state === "firing" ? "text-danger" : stateRow.state === "pending" ? "text-accent" : "text-ok",
                          )}
                        >
                          {stateRow.state}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {alerts.map((alert) => (
                <div key={alert.id} className="rounded-2xl bg-[#fffdf8] p-4 shadow-[0_10px_22px_rgba(70,86,94,0.09)]">
                  <div className="flex items-center justify-between gap-2">
                    <div
                      className={cn(
                        "rounded-full bg-[#f4eee4] px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.12em]",
                        sevClass(alert.severity),
                      )}
                    >
                      {alert.severity}
                    </div>
                    <div className="text-xs text-[#7d8893]">{new Date(alert.created_at).toLocaleString()}</div>
                  </div>
                  <div className="mt-2 text-sm text-[#2f3c46]">{alert.message}</div>
                </div>
              ))}
              {!alerts.length ? <div className="text-sm text-muted">No alerts yet.</div> : null}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Self-healing insights</div>
            <div className="text-sm text-muted">Wire your healing agent to /api/healing-actions to see real actions.</div>
          </CardHeader>
          <CardBody>
            <div className="space-y-3">
              {alertHistory.length ? (
                <div className="rounded-2xl border border-[#eadfce] bg-[#fffcf6] p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#5a6873]">Alert transitions</div>
                  <div className="space-y-2">
                    {alertHistory.slice(0, 5).map((historyRow) => (
                      <div key={historyRow.id} className="rounded-xl bg-[#fff9ef] px-3 py-2">
                        <div className="text-xs font-semibold text-[#30404a]">{historyRow.rule_key}</div>
                        <div className="text-xs text-[#5d6a74]">{historyRow.message}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {heals.map((heal) => (
                <div key={heal.id} className="rounded-2xl bg-[#f8fcff] p-4 shadow-[0_10px_22px_rgba(70,86,94,0.09)]">
                  <div className="flex items-center justify-between gap-2">
                    <div
                      className={cn(
                        "rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.12em]",
                        heal.status === "success" ? "bg-[#e7f8ef] text-ok" : "bg-[#fdecea] text-danger",
                      )}
                    >
                      {heal.status}
                    </div>
                    <div className="text-xs text-[#7d8893]">{new Date(heal.timestamp).toLocaleString()}</div>
                  </div>
                  <div className="mt-2 text-sm text-[#2f3c46]">{heal.action_taken}</div>
                </div>
              ))}
              {!heals.length ? <div className="text-sm text-muted">No healing actions yet.</div> : null}
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
