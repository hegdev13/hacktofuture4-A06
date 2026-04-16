"use client";

import { useEffect, useState } from "react";
import { useSelectedEndpointId } from "@/components/dashboard/use-endpoint";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { readSelectedEndpoint } from "@/lib/endpoints-client";
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

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

interface CostSummary {
  total_tokens: number;
  total_cost_usd: number;
  total_cost_inr?: number;
  healing_events_count: number;
  stages: Record<string, { tokens: number; cost: number }>;
  cost_per_heal: number;
  cost_per_heal_inr?: number;
  monthly_estimate: number;
  monthly_estimate_inr?: number;
  exchange_rate?: number;
  record_count?: number;
}

interface StageBreakdown {
  name: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  cost_percentage: number;
  token_percentage: number;
}

function sevClass(s: AlertRow["severity"]) {
  if (s === "high") return "text-danger";
  if (s === "medium") return "text-accent";
  return "text-ok";
}

export default function AlertsPage() {
  const endpointId = useSelectedEndpointId();
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [heals, setHeals] = useState<HealRow[]>([]);
  const [alertStates, setAlertStates] = useState<AlertStateRow[]>([]);
  const [alertHistory, setAlertHistory] = useState<AlertHistoryRow[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"alerts" | "costs">("costs");
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [stages, setStages] = useState<StageBreakdown[]>([]);
  const [costLoading, setCostLoading] = useState(false);

  // Fetch alerts data
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
          alert_states?: AlertStateRow[];
          alert_history?: AlertHistoryRow[];
        };
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        if (!Array.isArray(data.alerts)) throw new Error("Invalid response: missing alerts");
        if (!Array.isArray(data.healing_actions)) {
          throw new Error("Invalid response: missing healing actions");
        }

        if (!cancelled) {
          setAlerts(data.alerts);
          setHeals(data.healing_actions);
          setAlertStates(Array.isArray(data.alert_states) ? data.alert_states : []);
          setAlertHistory(Array.isArray(data.alert_history) ? data.alert_history.slice(0, 12) : []);
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

  // Fetch cost data
  useEffect(() => {
    async function fetchCosts() {
      setCostLoading(true);
      try {
        const response = await fetch("/api/cost-tracking/summary?days=28");
        if (response.ok) {
          const data = await response.json();
          setSummary(data);

          // Transform stages data
          const stagesArray: StageBreakdown[] = [];
          let totalCost = data.total_cost_usd || 0;
          let totalTokens = data.total_tokens || 0;

          Object.entries(data.stages || {}).forEach(([name, stats]: [string, any]) => {
            const stageName =
              name === "plan"
                ? "Plan Generation"
                : name === "options"
                  ? "Remediation Options"
                  : name === "summary"
                    ? "Summary Generation"
                    : name;

            stagesArray.push({
              name: stageName,
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: stats.tokens || 0,
              cost_usd: stats.cost || 0,
              cost_percentage: totalCost > 0 ? ((stats.cost || 0) / totalCost) * 100 : 0,
              token_percentage: totalTokens > 0 ? ((stats.tokens || 0) / totalTokens) * 100 : 0,
            });
          });

          if (stagesArray.length > 0) {
            setStages(stagesArray);
          }
        }
      } catch (error) {
        console.error("Failed to fetch costs:", error);
      } finally {
        setCostLoading(false);
      }
    }

    if (activeTab === "costs") {
      fetchCosts();
    }
  }, [activeTab]);

  if (!endpointId && activeTab === "alerts") {
    return (
      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Select an endpoint</div>
          <div className="text-sm text-muted">Use the top bar selector.</div>
        </CardHeader>
      </Card>
    );
  }

  const chartData = stages.map((s) => ({
    name: s.name,
    cost: parseFloat(s.cost_usd.toFixed(6)),
    tokens: s.total_tokens,
  }));

  const pieData = stages.map((s) => ({
    name: s.name,
    value: parseFloat(s.cost_percentage.toFixed(1)),
  }));

  const COLORS = ["#3b82f6", "#10b981", "#f59e0b"];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Cost Observatory Snapshot</div>
          <div className="text-sm text-muted">Live Gemini cost data from the last 28 days.</div>
        </CardHeader>
        <CardBody>
          {costLoading ? (
            <div className="text-sm text-muted">Loading cost summary...</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-4">
              <div className="rounded-2xl bg-[#fffdf8] p-4 shadow-[0_10px_22px_rgba(70,86,94,0.09)]">
                <div className="text-xs uppercase tracking-[0.12em] text-[#7d8893]">Total Cost</div>
                <div className="mt-2 space-y-1">
                  <div className="text-lg font-bold text-[#1f2b33]">${(summary?.total_cost_usd || 0).toFixed(6)}</div>
                  <div className="text-sm font-semibold text-[#7d8893]">₹{(summary?.total_cost_inr || 0).toFixed(2)}</div>
                </div>
              </div>
              <div className="rounded-2xl bg-[#fffdf8] p-4 shadow-[0_10px_22px_rgba(70,86,94,0.09)]">
                <div className="text-xs uppercase tracking-[0.12em] text-[#7d8893]">Total Tokens</div>
                <div className="mt-2 text-2xl font-bold text-[#1f2b33]">{(summary?.total_tokens || 0).toLocaleString()}</div>
              </div>
              <div className="rounded-2xl bg-[#fffdf8] p-4 shadow-[0_10px_22px_rgba(70,86,94,0.09)]">
                <div className="text-xs uppercase tracking-[0.12em] text-[#7d8893]">Healing Events</div>
                <div className="mt-2 text-2xl font-bold text-[#1f2b33]">{summary?.healing_events_count || 0}</div>
              </div>
              <div className="rounded-2xl bg-[#fffdf8] p-4 shadow-[0_10px_22px_rgba(70,86,94,0.09)]">
                <div className="text-xs uppercase tracking-[0.12em] text-[#7d8893]">Cost / Heal</div>
                <div className="mt-2 space-y-1">
                  <div className="text-lg font-bold text-[#1f2b33]">${(summary?.cost_per_heal || 0).toFixed(6)}</div>
                  <div className="text-sm font-semibold text-[#7d8893]">₹{(summary?.cost_per_heal_inr || 0).toFixed(4)}</div>
                </div>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Tab Selector */}
      <div className="flex gap-2">
        <button
          onClick={() => setActiveTab("alerts")}
          className={cn(
            "px-4 py-2 rounded-lg font-medium transition-colors",
            activeTab === "alerts"
              ? "bg-blue-600 text-white"
              : "bg-slate-700 text-slate-300 hover:bg-slate-600",
          )}
        >
          Alerts & Healing
        </button>
        <button
          onClick={() => setActiveTab("costs")}
          className={cn(
            "px-4 py-2 rounded-lg font-medium transition-colors",
            activeTab === "costs"
              ? "bg-green-600 text-white"
              : "bg-slate-700 text-slate-300 hover:bg-slate-600",
          )}
        >
          Cost Observatory
        </button>
      </div>

      {/* Alerts Tab */}
      {activeTab === "alerts" && (
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
                {alertStates.length ? (
                  <div className="rounded-2xl border border-[#eadfce] bg-[#fffcf6] p-3 text-xs text-[#50606c]">
                    <div className="mb-2 font-semibold text-[#2f3c46]">Current rule states</div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {alertStates.slice(0, 6).map((s) => (
                        <div key={`${s.rule_key}-${s.updated_at}`} className="rounded-xl bg-[#fff9ef] px-3 py-2">
                          <div className="font-medium text-[#2f3c46]">{s.rule_key}</div>
                          <div className={cn("uppercase tracking-[0.1em]", s.state === "firing" ? "text-danger" : s.state === "pending" ? "text-accent" : "text-ok")}>
                            {s.state}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

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
                {alertHistory.length ? (
                  <div className="rounded-2xl border border-[#eadfce] bg-[#fffcf6] p-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#5a6873]">
                      Alert transitions
                    </div>
                    <div className="space-y-2">
                      {alertHistory.slice(0, 5).map((h) => (
                        <div key={h.id} className="rounded-xl bg-[#fff9ef] px-3 py-2">
                          <div className="text-xs font-semibold text-[#30404a]">{h.rule_key}</div>
                          <div className="text-xs text-[#5d6a74]">{h.message}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

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
      )}

      {/* Costs Tab */}
      {activeTab === "costs" && (
        <div className="space-y-6">
          {costLoading ? (
            <Card>
              <CardBody>
                <div className="text-center">
                  <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent"></div>
                  <p className="mt-4 text-slate-400">Loading cost data...</p>
                </div>
              </CardBody>
            </Card>
          ) : (
            <>
              {/* KPI Cards */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                <Card>
                  <CardBody className="p-6">
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-slate-400">Total Cost</p>
                      <p className="text-2xl font-bold text-white">${(summary?.total_cost_usd || 0).toFixed(6)}</p>
                      <p className="text-sm font-semibold text-slate-300">₹{(summary?.total_cost_inr || 0).toFixed(2)}</p>
                    </div>
                  </CardBody>
                </Card>

                <Card>
                  <CardBody className="p-6">
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-slate-400">Total Tokens</p>
                      <p className="text-3xl font-bold text-white">{(summary?.total_tokens || 0).toLocaleString()}</p>
                    </div>
                  </CardBody>
                </Card>

                <Card>
                  <CardBody className="p-6">
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-slate-400">Healing Events</p>
                      <p className="text-3xl font-bold text-white">{summary?.healing_events_count || 0}</p>
                    </div>
                  </CardBody>
                </Card>

                <Card>
                  <CardBody className="p-6">
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-slate-400">Cost/Heal</p>
                      <p className="text-2xl font-bold text-white">${(summary?.cost_per_heal || 0).toFixed(6)}</p>
                      <p className="text-sm font-semibold text-slate-300">₹{(summary?.cost_per_heal_inr || 0).toFixed(4)}</p>
                    </div>
                  </CardBody>
                </Card>
              </div>

              {/* Monthly Projection */}
              <Card>
                <CardBody className="bg-gradient-to-r from-green-900/20 to-emerald-900/20 p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-green-400">📈 Monthly Projection (1000 events)</p>
                      <p className="mt-1 text-sm text-green-300/80">Based on current usage patterns</p>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold text-green-400">${(summary?.monthly_estimate || 0).toFixed(2)}</p>
                      <p className="text-sm font-semibold text-green-300">₹{(summary?.monthly_estimate_inr || 0).toFixed(0)}</p>
                    </div>
                  </div>
                </CardBody>
              </Card>

              {/* Charts */}
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <div className="text-lg font-semibold text-white">Cost Distribution</div>
                  </CardHeader>
                  <CardBody>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                        <XAxis dataKey="name" angle={-45} textAnchor="end" height={80} stroke="#9ca3af" />
                        <YAxis stroke="#9ca3af" />
                        <Tooltip
                          formatter={(value) => `$${(value as number).toFixed(6)}`}
                          contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #475569" }}
                          labelStyle={{ color: "#e2e8f0" }}
                        />
                        <Bar dataKey="cost" fill="#3b82f6" radius={[8, 8, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardBody>
                </Card>

                <Card>
                  <CardHeader>
                    <div className="text-lg font-semibold text-white">Cost Contribution %</div>
                  </CardHeader>
                  <CardBody>
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie
                          data={pieData}
                          cx="50%"
                          cy="50%"
                          labelLine={false}
                          label={({ name, value }) => `${name}: ${value}%`}
                          outerRadius={100}
                          fill="#8884d8"
                          dataKey="value"
                        >
                          {pieData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(value) => `${(value as number).toFixed(1)}%`}
                          contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #475569" }}
                          labelStyle={{ color: "#e2e8f0" }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </CardBody>
                </Card>
              </div>

              {/* Stage Breakdown Table */}
              <Card>
                <CardHeader>
                  <div className="text-lg font-semibold text-white">Stage-wise Breakdown</div>
                </CardHeader>
                <CardBody>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-700">
                          <th className="px-4 py-3 text-left font-semibold text-slate-300">Stage</th>
                          <th className="px-4 py-3 text-right font-semibold text-slate-300">Total Tokens</th>
                          <th className="px-4 py-3 text-right font-semibold text-slate-300">Cost USD</th>
                          <th className="px-4 py-3 text-right font-semibold text-slate-300">% of Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stages.map((stage, idx) => (
                          <tr key={idx} className="border-b border-slate-700/50 hover:bg-slate-700/20">
                            <td className="px-4 py-3 font-medium text-white">{stage.name}</td>
                            <td className="px-4 py-3 text-right text-slate-300">{stage.total_tokens.toLocaleString()}</td>
                            <td className="px-4 py-3 text-right font-medium text-green-400">${stage.cost_usd.toFixed(6)}</td>
                            <td className="px-4 py-3 text-right text-slate-300">{stage.cost_percentage.toFixed(1)}%</td>
                          </tr>
                        ))}
                        <tr className="border-t border-slate-700 bg-slate-700/30 font-semibold">
                          <td className="px-4 py-3 text-white">TOTAL</td>
                          <td className="px-4 py-3 text-right text-white">-</td>
                          <td className="px-4 py-3 text-right text-green-400">${(summary?.total_cost_usd || 0).toFixed(6)}</td>
                          <td className="px-4 py-3 text-right text-white">100%</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </CardBody>
              </Card>
            </>
          )}
        </div>
      )}
    </div>
  );
}


