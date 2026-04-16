"use client";

import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useSelectedEndpointId } from "@/components/dashboard/use-endpoint";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatBytes, formatNumber } from "@/lib/format";
import { readSelectedEndpoint } from "@/lib/endpoints-client";

type SnapshotRow = {
  id: string;
  endpoint_id: string;
  pod_name: string;
  namespace: string;
  status: string;
  cpu_usage: number | null;
  memory_usage: number | null;
  restart_count: number;
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

type CostSummaryResponse = {
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
  model_filter?: string;
  data_source?: string;
  recent_records?: Array<{
    stage: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number;
    created_at: string | null;
  }>;
};

function podsToRows(endpointId: string, pods: UpstreamPod[], fetchedAt: string): SnapshotRow[] {
  return pods.map((p) => ({
    id: crypto.randomUUID(),
    endpoint_id: endpointId,
    pod_name: p.pod_name,
    namespace: p.namespace ?? "default",
    status: p.status,
    cpu_usage: typeof p.cpu_usage === "number" ? p.cpu_usage : null,
    memory_usage: typeof p.memory_usage === "number" ? p.memory_usage : null,
    restart_count: p.restart_count ?? 0,
    timestamp: fetchedAt,
  }));
}

export default function MetricsPage() {
  const endpointId = useSelectedEndpointId();
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [costSummary, setCostSummary] = useState<CostSummaryResponse | null>(null);
  const [costError, setCostError] = useState<string | null>(null);

  useEffect(() => {
    if (!endpointId) {
      setRows([]);
      setFetchError(null);
      return;
    }

    const poll = async () => {
      try {
        const selected = await readSelectedEndpoint();
        if (!selected) {
          setRows([]);
          setFetchError("Selected endpoint not found");
          return;
        }

        const u = new URL("/api/dashboard/pods", window.location.origin);
        u.searchParams.set("endpoint", selected.id);
        const res = await fetch(u.toString(), { cache: "no-store" });
        const data = (await res.json()) as {
          error?: string;
          pods?: UpstreamPod[];
          fetched_at?: string;
        };
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        if (!Array.isArray(data.pods)) throw new Error("Invalid response: missing pods");
        setRows(podsToRows(selected.id, data.pods, data.fetched_at ?? new Date().toISOString()).slice(0, 800));
        setFetchError(null);
      } catch (e) {
        setFetchError(e instanceof Error ? e.message : String(e));
      }
    };

    void poll();
    const id = setInterval(() => {
      void poll();
    }, 4000);
    return () => clearInterval(id);
  }, [endpointId]);

  useEffect(() => {
    if (!endpointId) {
      setCostSummary(null);
      setCostError(null);
      return;
    }

    const pollCost = async () => {
      try {
        const selected = await readSelectedEndpoint();
        if (!selected) {
          setCostSummary(null);
          setCostError("Selected endpoint not found");
          return;
        }

        const url = new URL("/api/cost-tracking/summary", window.location.origin);
        url.searchParams.set("days", "30");
        url.searchParams.set("model", "gemini");

        const response = await fetch(url.toString(), { cache: "no-store" });
        const data = (await response.json()) as CostSummaryResponse & { error?: string; details?: string };
        if (!response.ok) {
          throw new Error(data.error || data.details || `Request failed (${response.status})`);
        }

        setCostSummary(data);
        setCostError(null);
      } catch (error) {
        setCostError(error instanceof Error ? error.message : String(error));
      }
    };

    void pollCost();
    const id = setInterval(() => {
      void pollCost();
    }, 10000);
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

  const statusDist = useMemo(() => {
    let running = 0;
    let pending = 0;
    let failed = 0;
    let other = 0;
    for (const r of latestByPod) {
      const s = r.status.toLowerCase();
      if (s.includes("running")) running += 1;
      else if (s.includes("pending")) pending += 1;
      else if (s.includes("crashloop") || s.includes("error") || s.includes("failed")) failed += 1;
      else other += 1;
    }
    return [
      { name: "Running", value: running, fill: "#5a9b7d" },
      { name: "Pending", value: pending, fill: "#db8a52" },
      { name: "Failed", value: failed, fill: "#ca5a58" },
      { name: "Other", value: other, fill: "#8a97a1" },
    ].filter((item) => item.value > 0);
  }, [latestByPod]);

  const restartTop = useMemo(() => {
    return [...latestByPod]
      .sort((a, b) => b.restart_count - a.restart_count)
      .slice(0, 8)
      .map((r) => ({
        pod: r.pod_name.length > 20 ? `${r.pod_name.slice(0, 20)}...` : r.pod_name,
        restarts: r.restart_count,
      }));
  }, [latestByPod]);

  const stageCostBars = useMemo(() => {
    if (!costSummary?.stages) return [];
    return Object.entries(costSummary.stages)
      .map(([stage, stats]) => ({
        stage: stage.length > 22 ? `${stage.slice(0, 22)}...` : stage,
        usd: Number(stats.cost || 0),
        tokens: Number(stats.tokens || 0),
      }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 10);
  }, [costSummary]);

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
    <div className="space-y-4">
      {fetchError ? (
        <Card>
          <CardBody>
            <div className="text-sm text-danger">Could not load metrics: {fetchError}</div>
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Pod Status Distribution</div>
            <div className="text-sm text-muted">Live breakdown from current snapshot.</div>
          </CardHeader>
          <CardBody className="h-64">
            {statusDist.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={statusDist} dataKey="value" nameKey="name" outerRadius={90} label />
                  <Tooltip
                    contentStyle={{
                      background: "#fff9f0",
                      border: "1px solid #e7ddcd",
                      color: "#2f3a42",
                      fontSize: 12,
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-sm text-muted">No status data yet.</div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Top Restarting Pods</div>
            <div className="text-sm text-muted">Highest restart_count pods right now.</div>
          </CardHeader>
          <CardBody className="h-64">
            {restartTop.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={restartTop} layout="vertical" margin={{ left: 10, right: 10, top: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(90,107,118,0.15)" />
                  <XAxis type="number" tick={{ fill: "#6f7a84", fontSize: 12 }} allowDecimals={false} />
                  <YAxis type="category" dataKey="pod" width={150} tick={{ fill: "#6f7a84", fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      background: "#fff9f0",
                      border: "1px solid #e7ddcd",
                      color: "#2f3a42",
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="restarts" fill="#db8a52" radius={[0, 8, 8, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-sm text-muted">No restart data yet.</div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">LLM Cost (Gemini · Real usage)</div>
          <div className="text-sm text-muted">
            Live totals from Supabase cost records for Gemini calls only.
          </div>
        </CardHeader>
        <CardBody>
          {costError ? <div className="text-sm text-danger">Could not load Gemini cost data: {costError}</div> : null}

          {costSummary ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl bg-[#fff9ef] p-3">
                  <div className="text-xs text-muted">Total tokens (30d)</div>
                  <div className="mt-1 text-xl font-semibold text-[#1f2b33]">{formatNumber(costSummary.total_tokens || 0)}</div>
                </div>
                <div className="rounded-xl bg-[#fff9ef] p-3">
                  <div className="text-xs text-muted">Total cost (USD)</div>
                  <div className="mt-1 text-xl font-semibold text-[#1f2b33]">${(costSummary.total_cost_usd || 0).toFixed(6)}</div>
                </div>
                <div className="rounded-xl bg-[#fff9ef] p-3">
                  <div className="text-xs text-muted">Total cost (INR)</div>
                  <div className="mt-1 text-xl font-semibold text-[#1f2b33]">₹{(costSummary.total_cost_inr || 0).toFixed(2)}</div>
                </div>
                <div className="rounded-xl bg-[#fff9ef] p-3">
                  <div className="text-xs text-muted">Gemini records</div>
                  <div className="mt-1 text-xl font-semibold text-[#1f2b33]">{formatNumber(costSummary.record_count || 0)}</div>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="h-64 rounded-xl border border-[#ede3d3] p-2">
                  {stageCostBars.length ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={stageCostBars} layout="vertical" margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(90,107,118,0.15)" />
                        <XAxis type="number" tick={{ fill: "#6f7a84", fontSize: 12 }} />
                        <YAxis type="category" dataKey="stage" width={150} tick={{ fill: "#6f7a84", fontSize: 11 }} />
                        <Tooltip
                          formatter={(value: number, key: string) =>
                            key === "usd" ? [`$${Number(value).toFixed(6)}`, "Cost"] : [formatNumber(Number(value)), "Tokens"]
                          }
                          contentStyle={{ background: "#fff9f0", border: "1px solid #e7ddcd", color: "#2f3a42", fontSize: 12 }}
                        />
                        <Bar dataKey="usd" fill="#5a9b7d" radius={[0, 8, 8, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="text-sm text-muted">No Gemini stage cost data yet.</div>
                  )}
                </div>

                <div className="rounded-xl border border-[#ede3d3] p-3">
                  <div className="mb-2 text-sm font-semibold text-[#1f2b33]">Cost summary</div>
                  <div className="space-y-1 text-sm text-[#4f5d68]">
                    <div>Healing events: {formatNumber(costSummary.healing_events_count || 0)}</div>
                    <div>Cost per heal: ${(costSummary.cost_per_heal || 0).toFixed(6)}</div>
                    <div>Cost per heal (INR): ₹{(costSummary.cost_per_heal_inr || 0).toFixed(4)}</div>
                    <div>Monthly estimate: ${(costSummary.monthly_estimate || 0).toFixed(2)}</div>
                    <div>Monthly estimate (INR): ₹{(costSummary.monthly_estimate_inr || 0).toFixed(2)}</div>
                    <div>USD/INR rate: {(costSummary.exchange_rate || 0).toFixed(2)}</div>
                    <div>Model filter: {costSummary.model_filter || "gemini"}</div>
                    <div>Data source: {costSummary.data_source || "supabase"}</div>
                  </div>
                </div>
              </div>

              {Array.isArray(costSummary.recent_records) && costSummary.recent_records.length ? (
                <div className="overflow-auto">
                  <div className="mb-2 text-sm font-semibold text-[#1f2b33]">Recent Gemini cost records</div>
                  <table className="min-w-full text-sm">
                    <thead className="text-xs text-muted">
                      <tr className="border-b border-[#ede3d3]">
                        <th className="py-2 text-left font-medium">Time</th>
                        <th className="py-2 text-left font-medium">Stage</th>
                        <th className="py-2 text-left font-medium">Model</th>
                        <th className="py-2 text-left font-medium">Input</th>
                        <th className="py-2 text-left font-medium">Output</th>
                        <th className="py-2 text-left font-medium">Total</th>
                        <th className="py-2 text-left font-medium">Cost (USD)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {costSummary.recent_records.map((record, idx) => (
                        <tr key={`${record.stage}-${record.created_at || idx}-${idx}`} className="border-b border-[#f0e7d9]">
                          <td className="py-2 text-[#4f5d68]">{record.created_at ? new Date(record.created_at).toLocaleString() : "—"}</td>
                          <td className="py-2 text-[#4f5d68]">{record.stage}</td>
                          <td className="py-2 text-[#4f5d68]">{record.model}</td>
                          <td className="py-2 text-[#4f5d68]">{formatNumber(record.input_tokens || 0)}</td>
                          <td className="py-2 text-[#4f5d68]">{formatNumber(record.output_tokens || 0)}</td>
                          <td className="py-2 text-[#4f5d68]">{formatNumber(record.total_tokens || 0)}</td>
                          <td className="py-2 text-[#4f5d68]">${Number(record.cost_usd || 0).toFixed(6)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="text-sm text-muted">Loading Gemini cost metrics...</div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Pod metrics</div>
          <div className="text-sm text-muted">
            Live snapshot per pod from your selected ngrok endpoint.
          </div>
        </CardHeader>
        <CardBody>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="text-xs text-muted">
                <tr className="border-b border-[#ede3d3]">
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
                  <tr key={`${r.namespace}/${r.pod_name}`} className="border-b border-[#f0e7d9]">
                    <td className="py-2 font-semibold text-[#27343d]">{r.pod_name}</td>
                    <td className="py-2 text-[#4f5d68]">{r.namespace}</td>
                    <td className="py-2 text-[#4f5d68]">{r.status}</td>
                    <td className="py-2 text-[#4f5d68]">
                      {r.cpu_usage == null ? "—" : formatNumber(r.cpu_usage)}
                    </td>
                    <td className="py-2 text-[#4f5d68]">
                      {r.memory_usage == null ? "—" : formatBytes(r.memory_usage)}
                    </td>
                    <td className="py-2 text-[#4f5d68]">{r.restart_count}</td>
                  </tr>
                ))}
                {!latestByPod.length ? (
                  <tr>
                    <td className="py-4 text-muted" colSpan={6}>
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

