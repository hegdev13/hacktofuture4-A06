"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";

type TopItem = { label: string; value: number; samples: number };
type DistributionItem = { label: string; value: number; percent?: number };
type GaugeResponse = {
  normalized: number;
  status: "healthy" | "warning" | "critical";
  thresholds: { warning: number; critical: number };
};
type HeatmapPoint = { timestamp: string; pod: string; value: number; density: number };
type HistogramBucket = { bucket_start: number; bucket_end: number; count: number };
type PodsDetailsRow = {
  pod: string;
  namespace: string;
  status: string;
  cpu: number;
  memory: number;
  restarts: number;
  health_score: number;
};
type StateTimelinePoint = { timestamp: string; pod: string; namespace: string; state: string };
type Annotation = { id: string; timestamp: string; title: string; severity: string; event_type: string };
type LogRow = { timestamp: string; level: string; source: string; message: string };
type AlertState = { rule_key: string; state: "pending" | "firing" | "resolved" };

const PIE_COLORS = ["#5a9b7d", "#db8a52", "#ca5a58", "#8a97a1", "#4e8f9b", "#c97f9f"];

function stateColor(state: string) {
  const s = state.toLowerCase();
  if (s.includes("running") || s.includes("resolved")) return "#5a9b7d";
  if (s.includes("pending")) return "#db8a52";
  return "#ca5a58";
}

function gaugeColor(value: number) {
  if (value >= 90) return "#ca5a58";
  if (value >= 70) return "#db8a52";
  return "#5a9b7d";
}

function heatColor(value: number, max: number) {
  if (max <= 0) return "#f8f1e6";
  const ratio = Math.max(0, Math.min(1, value / max));
  if (ratio > 0.8) return "#ca5a58";
  if (ratio > 0.6) return "#d97757";
  if (ratio > 0.4) return "#db8a52";
  if (ratio > 0.2) return "#e7b27c";
  return "#f2dfc5";
}

export default function AdvancedObservabilityPanels({ endpointId }: { endpointId: string }) {
  const [topRestarts, setTopRestarts] = useState<TopItem[]>([]);
  const [statusDistribution, setStatusDistribution] = useState<DistributionItem[]>([]);
  const [cpuGauge, setCpuGauge] = useState<GaugeResponse | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapPoint[]>([]);
  const [histogram, setHistogram] = useState<HistogramBucket[]>([]);
  const [podDetails, setPodDetails] = useState<PodsDetailsRow[]>([]);
  const [stateTimeline, setStateTimeline] = useState<StateTimelinePoint[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [alertStates, setAlertStates] = useState<AlertState[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const [
          topRes,
          distRes,
          gaugeRes,
          heatRes,
          histRes,
          podsRes,
          stateRes,
          annoRes,
          logsRes,
          alertsRes,
        ] = await Promise.all([
          fetch(`/api/metrics/top?endpoint=${encodeURIComponent(endpointId)}&metric=restart_count&groupBy=pod&limit=10`, { cache: "no-store" }),
          fetch(`/api/metrics/distribution?endpoint=${encodeURIComponent(endpointId)}&type=pod_status`, { cache: "no-store" }),
          fetch(`/api/metrics/gauge?endpoint=${encodeURIComponent(endpointId)}&metric=cpu_usage`, { cache: "no-store" }),
          fetch(`/api/metrics/heatmap?endpoint=${encodeURIComponent(endpointId)}&metric=cpu_usage&step=30&limit=5000`, { cache: "no-store" }),
          fetch(`/api/metrics/histogram?endpoint=${encodeURIComponent(endpointId)}&metric=cpu_usage&bins=12`, { cache: "no-store" }),
          fetch(`/api/pods/details?endpoint=${encodeURIComponent(endpointId)}&page=1&pageSize=8&sortBy=health_score&order=asc`, { cache: "no-store" }),
          fetch(`/api/pods/state-timeline?endpoint=${encodeURIComponent(endpointId)}&step=60&limit=500`, { cache: "no-store" }),
          fetch(`/api/events/annotations?endpoint=${encodeURIComponent(endpointId)}&limit=10`, { cache: "no-store" }),
          fetch(`/api/logs/query?endpoint=${encodeURIComponent(endpointId)}&limit=100`, { cache: "no-store" }),
          fetch(`/api/alerts?endpoint=${encodeURIComponent(endpointId)}`, { cache: "no-store" }),
        ]);

        const parse = async (res: Response) => {
          if (!res.ok) return null;
          return res.json();
        };

        const [topData, distData, gaugeData, heatData, histData, podsData, stateData, annoData, logsData, alertsData] = await Promise.all([
          parse(topRes),
          parse(distRes),
          parse(gaugeRes),
          parse(heatRes),
          parse(histRes),
          parse(podsRes),
          parse(stateRes),
          parse(annoRes),
          parse(logsRes),
          parse(alertsRes),
        ]);

        if (cancelled) return;

        setTopRestarts(Array.isArray(topData?.items) ? topData.items : []);
        setStatusDistribution(Array.isArray(distData?.distribution) ? distData.distribution : []);
        setCpuGauge(gaugeData && typeof gaugeData.normalized === "number" ? gaugeData : null);
        setHeatmap(Array.isArray(heatData?.points) ? heatData.points.slice(-120) : []);
        setHistogram(Array.isArray(histData?.buckets) ? histData.buckets : []);
        setPodDetails(Array.isArray(podsData?.rows) ? podsData.rows : []);
        setStateTimeline(Array.isArray(stateData?.points) ? stateData.points.slice(-160) : []);
        setAnnotations(Array.isArray(annoData?.annotations) ? annoData.annotations : []);
        setLogs(Array.isArray(logsData?.logs) ? logsData.logs.slice(0, 20) : []);
        setAlertStates(Array.isArray(alertsData?.alert_states) ? alertsData.alert_states : []);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };

    void poll();
    const id = setInterval(() => {
      void poll();
    }, 8000);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [endpointId]);

  const gaugeData = useMemo(() => {
    const value = cpuGauge?.normalized ?? 0;
    return [{ name: "CPU", value, fill: gaugeColor(value) }];
  }, [cpuGauge]);

  const heatLegendMax = useMemo(() => {
    return heatmap.length ? Math.max(...heatmap.map((p) => p.value)) : 0;
  }, [heatmap]);

  const histogramData = useMemo(() => {
    return histogram.map((b) => ({
      range: `${b.bucket_start.toFixed(2)}-${b.bucket_end.toFixed(2)}`,
      count: b.count,
    }));
  }, [histogram]);

  const logsByLevel = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of logs) map.set(row.level || "info", (map.get(row.level || "info") ?? 0) + 1);
    return Array.from(map.entries()).map(([level, count]) => ({ level, count }));
  }, [logs]);

  const timelineRows = useMemo(() => {
    const byPod = new Map<string, StateTimelinePoint[]>();
    for (const p of stateTimeline) {
      const key = `${p.namespace}/${p.pod}`;
      const arr = byPod.get(key) ?? [];
      arr.push(p);
      byPod.set(key, arr);
    }
    return Array.from(byPod.entries()).slice(0, 8);
  }, [stateTimeline]);

  return (
    <div className="space-y-6">
      {error ? (
        <Card>
          <CardBody>
            <div className="text-sm text-danger">Advanced panels failed to load: {error}</div>
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <div className="text-lg font-bold tracking-tight text-[#1f2b33]">Bar: Top restarting pods</div>
          </CardHeader>
          <CardBody className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topRestarts} layout="vertical" margin={{ top: 4, right: 6, left: 6, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(90,107,118,0.15)" />
                <XAxis type="number" tick={{ fill: "#6f7a84", fontSize: 12 }} allowDecimals={false} />
                <YAxis type="category" dataKey="label" width={110} tick={{ fill: "#6f7a84", fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="value" fill="#db8a52" radius={[0, 8, 8, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-lg font-bold tracking-tight text-[#1f2b33]">Pie: Pod status distribution</div>
          </CardHeader>
          <CardBody className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={statusDistribution} dataKey="value" nameKey="label" outerRadius={85} label>
                  {statusDistribution.map((entry, index) => (
                    <Cell key={`${entry.label}-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-lg font-bold tracking-tight text-[#1f2b33]">Gauge: CPU utilization</div>
          </CardHeader>
          <CardBody className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <RadialBarChart
                innerRadius="65%"
                outerRadius="100%"
                barSize={18}
                data={gaugeData}
                startAngle={180}
                endAngle={0}
                cx="50%"
                cy="65%"
              >
                <RadialBar background dataKey="value" cornerRadius={10} />
                <Tooltip />
              </RadialBarChart>
            </ResponsiveContainer>
            <div className="-mt-8 text-center">
              <div className="text-2xl font-semibold text-[#27343d]">{formatNumber(cpuGauge?.normalized ?? 0)}%</div>
              <div className="text-xs text-muted">{cpuGauge?.status ?? "healthy"}</div>
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="text-lg font-bold tracking-tight text-[#1f2b33]">Heatmap: CPU over pods and time</div>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-12 gap-1">
              {heatmap.map((p, idx) => (
                <div
                  key={`${p.timestamp}-${p.pod}-${idx}`}
                  className="h-5 rounded"
                  title={`${p.pod} ${new Date(p.timestamp).toLocaleTimeString()} ${formatNumber(p.value)}`}
                  style={{ backgroundColor: heatColor(p.value, heatLegendMax) }}
                />
              ))}
              {!heatmap.length ? <div className="text-sm text-muted">No heatmap samples yet.</div> : null}
            </div>
            <div className="mt-2 text-xs text-muted">Darker cells mean higher CPU.</div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-lg font-bold tracking-tight text-[#1f2b33]">Histogram: CPU distribution</div>
          </CardHeader>
          <CardBody className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={histogramData} margin={{ top: 4, right: 6, left: 6, bottom: 18 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(90,107,118,0.15)" />
                <XAxis dataKey="range" tick={{ fill: "#6f7a84", fontSize: 10 }} angle={-25} textAnchor="end" height={55} />
                <YAxis tick={{ fill: "#6f7a84", fontSize: 12 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="count" fill="#4e8f9b" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardBody>
        </Card>
      </div>

      <Card>
          <CardHeader>
            <div className="text-lg font-bold tracking-tight text-[#1f2b33]">State timeline</div>
          </CardHeader>
          <CardBody>
            <div className="space-y-2">
              {timelineRows.map(([podKey, points]) => (
                <div key={podKey} className="rounded-xl border border-[#e9decd] bg-[#fffdf8] p-2">
                  <div className="mb-1 text-xs font-semibold text-[#2f3c46]">{podKey}</div>
                  <div className="flex flex-wrap gap-1">
                    {points.slice(-18).map((p, i) => (
                      <span
                        key={`${podKey}-${p.timestamp}-${i}`}
                        className="inline-block h-3 w-3 rounded-full"
                        title={`${new Date(p.timestamp).toLocaleTimeString()} - ${p.state}`}
                        style={{ backgroundColor: stateColor(p.state) }}
                      />
                    ))}
                  </div>
                </div>
              ))}
              {!timelineRows.length ? <div className="text-sm text-muted">No state timeline points yet.</div> : null}
            </div>
          </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="text-lg font-bold tracking-tight text-[#1f2b33]">Logs visualization</div>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={logsByLevel}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(90,107,118,0.15)" />
                  <XAxis dataKey="level" tick={{ fill: "#6f7a84", fontSize: 11 }} />
                  <YAxis tick={{ fill: "#6f7a84", fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#8a97a1" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="max-h-40 overflow-auto rounded-xl border border-[#e9decd] bg-[#fffdf8] p-2 text-xs">
              {logs.map((l, idx) => (
                <div key={`${l.timestamp}-${idx}`} className="border-b border-[#f0e7d9] py-1 text-[#36434d]">
                  [{new Date(l.timestamp).toLocaleTimeString()}] [{l.level}] {l.message}
                </div>
              ))}
              {!logs.length ? <div className="text-muted">No logs yet.</div> : null}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-lg font-bold tracking-tight text-[#1f2b33]">Alerts visualization</div>
          </CardHeader>
          <CardBody className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl bg-[#fff9ef] p-3 text-center">
                <div className="text-xs text-muted">Pending</div>
                <div className="text-xl font-semibold text-accent">
                  {alertStates.filter((a) => a.state === "pending").length}
                </div>
              </div>
              <div className="rounded-xl bg-[#fff2ef] p-3 text-center">
                <div className="text-xs text-muted">Firing</div>
                <div className="text-xl font-semibold text-danger">
                  {alertStates.filter((a) => a.state === "firing").length}
                </div>
              </div>
              <div className="rounded-xl bg-[#f1fbf3] p-3 text-center">
                <div className="text-xs text-muted">Resolved</div>
                <div className="text-xl font-semibold text-ok">
                  {alertStates.filter((a) => a.state === "resolved").length}
                </div>
              </div>
            </div>
            <div className="max-h-44 overflow-auto rounded-xl border border-[#e9decd] bg-[#fffdf8] p-2 text-xs">
              {alertStates.map((a, idx) => (
                <div key={`${a.rule_key}-${idx}`} className="border-b border-[#f0e7d9] py-1 text-[#36434d]">
                  [{a.state}] {a.rule_key}
                </div>
              ))}
              {!alertStates.length ? <div className="text-muted">No alert states yet.</div> : null}
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="text-lg font-bold tracking-tight text-[#1f2b33]">Annotations and pod table</div>
        </CardHeader>
        <CardBody>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              {annotations.map((a) => (
                <div key={a.id} className="rounded-xl border border-[#e9decd] bg-[#fffdf8] px-3 py-2">
                  <div className="text-sm font-semibold text-[#2f3c46]">{a.title}</div>
                  <div className="text-xs text-muted">
                    {new Date(a.timestamp).toLocaleString()} | {a.event_type} | {a.severity}
                  </div>
                </div>
              ))}
              {!annotations.length ? <div className="text-sm text-muted">No annotations yet.</div> : null}
            </div>

            <div className="overflow-auto">
              <table className="min-w-full text-xs">
                <thead className="text-muted">
                  <tr className="border-b border-[#ede3d3]">
                    <th className="py-2 text-left">Pod</th>
                    <th className="py-2 text-left">CPU</th>
                    <th className="py-2 text-left">Restarts</th>
                    <th className="py-2 text-left">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {podDetails.map((p) => (
                    <tr key={`${p.namespace}/${p.pod}`} className="border-b border-[#f0e7d9]">
                      <td className="py-2 text-[#27343d]">{p.pod}</td>
                      <td className="py-2 text-[#4f5d68]">{formatNumber(p.cpu)}</td>
                      <td className="py-2 text-[#4f5d68]">{p.restarts}</td>
                      <td className="py-2 text-[#4f5d68]">{p.health_score}</td>
                    </tr>
                  ))}
                  {!podDetails.length ? (
                    <tr>
                      <td className="py-4 text-muted" colSpan={4}>
                        No pod details yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
