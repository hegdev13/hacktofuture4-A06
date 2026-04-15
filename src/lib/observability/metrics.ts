import "server-only";

import type { ClusterSnapshot } from "@/lib/kube/types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type {
  NormalizedMetricPoint,
  PromLikePoint,
  PromLikeQuery,
  PromLikeQueryResult,
  PromLikeSeries,
} from "@/lib/observability/types";

type SnapshotRow = {
  endpoint_id: string;
  pod_name: string;
  namespace: string;
  status: string;
  cpu_usage: number | null;
  memory_usage: number | null;
  restart_count: number;
  timestamp: string;
};

type ParsedExpr = {
  fn: "raw" | "sum" | "avg" | "min" | "max" | "rate";
  metric: string;
  rateWindowSeconds?: number;
};

function toIso(input?: string, fallback = new Date().toISOString()) {
  if (!input) return fallback;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString();
}

function floorToStep(tsMs: number, stepSeconds: number) {
  const stepMs = Math.max(1, stepSeconds) * 1000;
  return Math.floor(tsMs / stepMs) * stepMs;
}

function parseDurationToSeconds(raw: string) {
  const m = raw.trim().match(/^(\d+)([smhd])$/i);
  if (!m) return 300;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "s") return n;
  if (unit === "m") return n * 60;
  if (unit === "h") return n * 3600;
  return n * 86400;
}

function parseExpression(input: string): ParsedExpr {
  const q = input.trim();
  const rateMatch = q.match(/^rate\(([^,]+),\s*([^)]+)\)$/i);
  if (rateMatch) {
    return {
      fn: "rate",
      metric: rateMatch[1].trim(),
      rateWindowSeconds: parseDurationToSeconds(rateMatch[2]),
    };
  }

  const aggMatch = q.match(/^(sum|avg|min|max)\(([^)]+)\)$/i);
  if (aggMatch) {
    return {
      fn: aggMatch[1].toLowerCase() as ParsedExpr["fn"],
      metric: aggMatch[2].trim(),
    };
  }

  if (q === "avg_cpu_usage") {
    return { fn: "avg", metric: "cpu_usage" };
  }
  if (q === "avg_memory_usage") {
    return { fn: "avg", metric: "memory_usage" };
  }
  if (q === "restart_rate") {
    return { fn: "rate", metric: "restart_count", rateWindowSeconds: 300 };
  }

  return { fn: "raw", metric: q };
}

function average(values: number[]) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function aggregate(fn: ParsedExpr["fn"], values: number[]) {
  if (!values.length) return 0;
  if (fn === "sum") return values.reduce((a, b) => a + b, 0);
  if (fn === "avg") return average(values);
  if (fn === "min") return Math.min(...values);
  if (fn === "max") return Math.max(...values);
  return values[values.length - 1];
}

type RangeAndFilters = {
  from?: string;
  to?: string;
  namespace?: string;
  pod?: string;
  node?: string;
};

type TopMetricInput = RangeAndFilters & {
  metric: string;
  groupBy?: string;
  aggregation?: "sum" | "avg" | "min" | "max";
  limit?: number;
  sort?: "asc" | "desc";
};

type HistogramInput = RangeAndFilters & {
  metric: string;
  bins?: number;
};

type PodsDetailsInput = RangeAndFilters & {
  status?: string;
  search?: string;
  sortBy?: "pod" | "namespace" | "status" | "cpu" | "memory" | "restarts" | "health_score";
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

type StateTimelineInput = RangeAndFilters & {
  stepSeconds?: number;
  limit?: number;
};

function normalizeMetricPercent(metric: string, value: number) {
  if (!Number.isFinite(value)) return 0;
  if (metric === "cpu_usage") {
    if (value <= 1.5) return Math.max(0, Math.min(100, value * 100));
    return Math.max(0, Math.min(100, value));
  }
  return Math.max(0, Math.min(100, value));
}

function healthScore(cpuRaw: number, memoryRaw: number, restartCount: number, status: string) {
  const cpu = normalizeMetricPercent("cpu_usage", cpuRaw);
  const memory = memoryRaw > 0 ? Math.min(100, memoryRaw / 1024 / 1024 / 1024 * 100) : 0;
  const restartPenalty = Math.min(40, restartCount * 8);
  const statusPenalty = status.toLowerCase().includes("running") ? 0 : status.toLowerCase().includes("pending") ? 10 : 35;
  const score = 100 - cpu * 0.45 - memory * 0.25 - restartPenalty - statusPenalty;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function parseAggregation(aggregation?: string): "sum" | "avg" | "min" | "max" {
  if (aggregation === "avg" || aggregation === "min" || aggregation === "max") return aggregation;
  return "sum";
}

function aggregateValues(values: number[], aggregation: "sum" | "avg" | "min" | "max") {
  if (!values.length) return 0;
  if (aggregation === "sum") return values.reduce((a, b) => a + b, 0);
  if (aggregation === "avg") return average(values);
  if (aggregation === "min") return Math.min(...values);
  return Math.max(...values);
}

async function queryMetricSeriesRows(endpointId: string, metricName: string, input: RangeAndFilters, limit = 20000) {
  const admin = createSupabaseAdminClient();
  const from = toIso(input.from, new Date(Date.now() - 60 * 60_000).toISOString());
  const to = toIso(input.to);

  let query = admin
    .from("metrics_series")
    .select("metric_name,labels,value,timestamp")
    .eq("endpoint_id", endpointId)
    .eq("metric_name", metricName)
    .gte("timestamp", from)
    .lte("timestamp", to)
    .order("timestamp", { ascending: true })
    .limit(Math.min(50000, Math.max(100, limit)));

  if (input.namespace) query = query.filter("labels->>namespace", "eq", input.namespace);
  if (input.pod) query = query.filter("labels->>pod", "eq", input.pod);
  if (input.node) query = query.filter("labels->>node", "eq", input.node);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return {
    range: { from, to },
    rows: (data ?? []) as Array<{
      metric_name: string;
      labels: Record<string, string>;
      value: number;
      timestamp: string;
    }>,
  };
}

export function normalizeSnapshotToSeries(
  endpointId: string,
  snapshot: ClusterSnapshot,
  source: NormalizedMetricPoint["source"] = "scrape",
): NormalizedMetricPoint[] {
  const ts = toIso(snapshot.fetched_at);
  const out: NormalizedMetricPoint[] = [];

  for (const pod of snapshot.pods) {
    const labels = {
      pod: pod.pod_name,
      namespace: pod.namespace ?? "default",
      status: pod.status,
    };

    if (typeof pod.cpu_usage === "number") {
      out.push({
        endpoint_id: endpointId,
        metric_name: "cpu_usage",
        labels,
        value: pod.cpu_usage,
        timestamp: ts,
        source,
      });
    }

    if (typeof pod.memory_usage === "number") {
      out.push({
        endpoint_id: endpointId,
        metric_name: "memory_usage",
        labels,
        value: pod.memory_usage,
        timestamp: ts,
        source,
      });
    }

    out.push({
      endpoint_id: endpointId,
      metric_name: "restart_count",
      labels,
      value: pod.restart_count ?? 0,
      timestamp: ts,
      source,
    });

    const s = pod.status.toLowerCase();
    out.push({
      endpoint_id: endpointId,
      metric_name: "pod_up",
      labels,
      value: s.includes("running") ? 1 : 0,
      timestamp: ts,
      source,
    });
  }

  return out;
}

export async function ingestSnapshotMetrics(endpointId: string, snapshot: ClusterSnapshot) {
  const admin = createSupabaseAdminClient();
  const fetchedAt = toIso(snapshot.fetched_at);

  const rows: SnapshotRow[] = snapshot.pods.map((p) => ({
    endpoint_id: endpointId,
    pod_name: p.pod_name,
    namespace: p.namespace ?? "default",
    status: p.status,
    cpu_usage: typeof p.cpu_usage === "number" ? p.cpu_usage : null,
    memory_usage: typeof p.memory_usage === "number" ? p.memory_usage : null,
    restart_count: p.restart_count ?? 0,
    timestamp: fetchedAt,
  }));

  if (rows.length) {
    const { error } = await admin.from("metrics_snapshots").insert(rows);
    if (error) {
      throw new Error(error.message);
    }
  }

  const normalized = normalizeSnapshotToSeries(endpointId, { ...snapshot, fetched_at: fetchedAt });
  if (normalized.length) {
    const { error } = await admin.from("metrics_series").insert(
      normalized.map((m) => ({
        endpoint_id: m.endpoint_id,
        metric_name: m.metric_name,
        labels: m.labels,
        value: m.value,
        source: m.source,
        timestamp: m.timestamp,
      })),
    );
    if (error) {
      throw new Error(error.message);
    }
  }

  await upsertPreAggregation(endpointId, rows);
  return { samples: normalized.length, snapshots: rows.length, fetched_at: fetchedAt };
}

export async function ingestPushedMetrics(payload: {
  endpoint_id: string;
  metrics: Array<{
    metric_name: string;
    labels?: Record<string, string>;
    value: number;
    timestamp?: string;
  }>;
}) {
  const admin = createSupabaseAdminClient();
  const rows = payload.metrics.map((m) => ({
    endpoint_id: payload.endpoint_id,
    metric_name: m.metric_name,
    labels: m.labels ?? {},
    value: m.value,
    source: "push",
    timestamp: toIso(m.timestamp),
  }));
  if (!rows.length) return { inserted: 0 };

  const { error } = await admin.from("metrics_series").insert(rows);
  if (error) throw new Error(error.message);
  return { inserted: rows.length };
}

async function upsertPreAggregation(endpointId: string, rows: SnapshotRow[]) {
  if (!rows.length) return;

  const admin = createSupabaseAdminClient();
  const ts = toIso(rows[0].timestamp);
  const bucket = new Date(ts);
  bucket.setSeconds(0, 0);
  const bucketStart = bucket.toISOString();

  let running = 0;
  let failed = 0;
  let pending = 0;
  const cpu: number[] = [];
  const memory: number[] = [];
  let restarts = 0;

  for (const r of rows) {
    const s = r.status.toLowerCase();
    if (s.includes("running")) running += 1;
    else if (s.includes("pending")) pending += 1;
    else failed += 1;

    if (typeof r.cpu_usage === "number") cpu.push(r.cpu_usage);
    if (typeof r.memory_usage === "number") memory.push(r.memory_usage);
    restarts += r.restart_count;
  }

  const clusterRow = {
    endpoint_id: endpointId,
    bucket_start: bucketStart,
    scope: "cluster",
    group_key: "all",
    avg_cpu: cpu.length ? average(cpu) : null,
    avg_memory: memory.length ? average(memory) : null,
    pod_running: running,
    pod_failed: failed,
    pod_pending: pending,
    restart_rate: rows.length ? restarts / rows.length : 0,
    sample_count: rows.length,
  };

  const podRows = rows.map((r) => ({
    endpoint_id: endpointId,
    bucket_start: bucketStart,
    scope: "pod",
    group_key: `${r.namespace}/${r.pod_name}`,
    avg_cpu: r.cpu_usage,
    avg_memory: r.memory_usage,
    pod_running: r.status.toLowerCase().includes("running") ? 1 : 0,
    pod_failed:
      r.status.toLowerCase().includes("failed") ||
      r.status.toLowerCase().includes("error") ||
      r.status.toLowerCase().includes("crashloop")
        ? 1
        : 0,
    pod_pending: r.status.toLowerCase().includes("pending") ? 1 : 0,
    restart_rate: r.restart_count,
    sample_count: 1,
  }));

  const { error } = await admin.from("metrics_rollups").upsert([clusterRow, ...podRows], {
    onConflict: "endpoint_id,bucket_start,scope,group_key",
  });
  if (error) {
    throw new Error(error.message);
  }
}

export async function getMetricsSummary(endpointId: string, range?: { from?: string; to?: string }) {
  const admin = createSupabaseAdminClient();
  const from = toIso(range?.from, new Date(Date.now() - 10 * 60_000).toISOString());
  const to = toIso(range?.to);

  const { data, error } = await admin
    .from("metrics_rollups")
    .select("bucket_start,avg_cpu,avg_memory,pod_running,pod_failed,pod_pending,restart_rate,sample_count")
    .eq("endpoint_id", endpointId)
    .eq("scope", "cluster")
    .gte("bucket_start", from)
    .lte("bucket_start", to)
    .order("bucket_start", { ascending: true })
    .limit(1000);

  if (error) {
    throw new Error(error.message);
  }

  const rows = data ?? [];
  const latest = rows[rows.length - 1] ?? null;

  return {
    range: { from, to },
    latest,
    points: rows,
  };
}

export async function queryPromLikeMetrics(endpointId: string, input: PromLikeQuery): Promise<PromLikeQueryResult> {
  const parsed = parseExpression(input.query);
  const nowIso = new Date().toISOString();
  const from = toIso(input.from, new Date(Date.now() - 15 * 60_000).toISOString());
  const to = toIso(input.to, nowIso);
  const stepSeconds = Math.min(3600, Math.max(1, input.stepSeconds ?? 30));
  const limit = Math.min(10000, Math.max(100, input.limit ?? 4000));

  const admin = createSupabaseAdminClient();
  let query = admin
    .from("metrics_series")
    .select("metric_name,labels,value,timestamp")
    .eq("endpoint_id", endpointId)
    .eq("metric_name", parsed.metric)
    .gte("timestamp", from)
    .lte("timestamp", to)
    .order("timestamp", { ascending: true })
    .limit(limit);

  if (input.namespace) query = query.filter("labels->>namespace", "eq", input.namespace);
  if (input.pod) query = query.filter("labels->>pod", "eq", input.pod);
  if (input.node) query = query.filter("labels->>node", "eq", input.node);

  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as Array<{
    metric_name: string;
    labels: Record<string, string>;
    value: number;
    timestamp: string;
  }>;

  const grouped = new Map<string, { metric: string; labels: Record<string, string>; points: PromLikePoint[] }>();

  for (const row of rows) {
    const labelValue = input.groupBy ? row.labels?.[input.groupBy] ?? "unknown" : "all";
    const labels = input.groupBy ? { [input.groupBy]: labelValue } : {};
    const key = `${parsed.metric}|${labelValue}`;
    const entry = grouped.get(key) ?? { metric: row.metric_name, labels, points: [] };
    entry.points.push({ timestamp: row.timestamp, value: Number(row.value) });
    grouped.set(key, entry);
  }

  const series: PromLikeSeries[] = [];

  for (const g of grouped.values()) {
    if (parsed.fn === "raw") {
      series.push({ metric_name: g.metric, labels: g.labels, points: g.points });
      continue;
    }

    const bucketMap = new Map<number, number[]>();
    for (const p of g.points) {
      const b = floorToStep(Date.parse(p.timestamp), stepSeconds);
      const arr = bucketMap.get(b) ?? [];
      arr.push(p.value);
      bucketMap.set(b, arr);
    }

    const aggPoints: PromLikePoint[] = [];
    for (const [bucketTs, vals] of bucketMap.entries()) {
      const bucketIso = new Date(bucketTs).toISOString();
      if (parsed.fn === "rate") {
        const sorted = [...vals];
        const delta = sorted[sorted.length - 1] - sorted[0];
        const perSec = delta / Math.max(1, parsed.rateWindowSeconds ?? stepSeconds);
        aggPoints.push({ timestamp: bucketIso, value: Number.isFinite(perSec) ? perSec : 0 });
      } else {
        aggPoints.push({ timestamp: bucketIso, value: aggregate(parsed.fn, vals) });
      }
    }

    aggPoints.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    series.push({
      metric_name: parsed.metric,
      labels: g.labels,
      points: aggPoints,
    });
  }

  return {
    expression: input.query,
    metric_name: parsed.metric,
    function: parsed.fn,
    groupBy: input.groupBy,
    range: { from, to },
    series,
  };
}

export async function getTopMetrics(endpointId: string, input: TopMetricInput) {
  const groupBy = input.groupBy ?? "pod";
  const aggregation = parseAggregation(input.aggregation);
  const limit = Math.min(100, Math.max(1, input.limit ?? 10));
  const sort = input.sort === "asc" ? "asc" : "desc";

  const { range, rows } = await queryMetricSeriesRows(endpointId, input.metric, input, 40000);
  const buckets = new Map<string, number[]>();

  for (const row of rows) {
    const label = row.labels?.[groupBy] ?? "unknown";
    const values = buckets.get(label) ?? [];
    values.push(Number(row.value));
    buckets.set(label, values);
  }

  const items = Array.from(buckets.entries()).map(([label, values]) => ({
    label,
    value: aggregateValues(values, aggregation),
    samples: values.length,
  }));

  items.sort((a, b) => (sort === "asc" ? a.value - b.value : b.value - a.value));

  return {
    metric: input.metric,
    groupBy,
    aggregation,
    range,
    items: items.slice(0, limit),
  };
}

export async function getMetricDistribution(endpointId: string, input: {
  type: "pod_status" | "resource_split";
  metric?: string;
  from?: string;
  to?: string;
  namespace?: string;
  pod?: string;
}) {
  const admin = createSupabaseAdminClient();
  const from = toIso(input.from, new Date(Date.now() - 30 * 60_000).toISOString());
  const to = toIso(input.to);

  if (input.type === "pod_status") {
    let query = admin
      .from("metrics_snapshots")
      .select("pod_name,namespace,status,timestamp")
      .eq("endpoint_id", endpointId)
      .gte("timestamp", from)
      .lte("timestamp", to)
      .order("timestamp", { ascending: false })
      .limit(5000);

    if (input.namespace) query = query.eq("namespace", input.namespace);
    if (input.pod) query = query.eq("pod_name", input.pod);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const latestByPod = new Map<string, string>();
    for (const row of data ?? []) {
      const key = `${row.namespace}/${row.pod_name}`;
      if (!latestByPod.has(key)) latestByPod.set(key, row.status);
    }

    const counts = new Map<string, number>();
    for (const status of latestByPod.values()) {
      const s = status.toLowerCase();
      const label = s.includes("running") ? "running" : s.includes("pending") ? "pending" : "failed";
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    return {
      type: "pod_status",
      range: { from, to },
      distribution: Array.from(counts.entries()).map(([label, value]) => ({ label, value })),
    };
  }

  const metric = input.metric ?? "cpu_usage";
  const { rows } = await queryMetricSeriesRows(endpointId, metric, input, 20000);
  const perPod = new Map<string, number>();
  for (const row of rows) {
    const podName = row.labels?.pod ?? "unknown";
    perPod.set(podName, (perPod.get(podName) ?? 0) + Number(row.value));
  }

  const total = Array.from(perPod.values()).reduce((a, b) => a + b, 0);
  const distribution = Array.from(perPod.entries())
    .map(([label, value]) => ({
      label,
      value,
      percent: total > 0 ? Number(((value / total) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 24);

  return {
    type: "resource_split",
    metric,
    range: { from, to },
    distribution,
  };
}

export async function getMetricGauge(endpointId: string, input: {
  metric: string;
  from?: string;
  to?: string;
  namespace?: string;
  pod?: string;
  node?: string;
}) {
  const metric = input.metric;
  const { range, rows } = await queryMetricSeriesRows(endpointId, metric, input, 8000);
  const values = rows.map((r) => Number(r.value)).filter((v) => Number.isFinite(v));
  const current = values.length ? values[values.length - 1] : 0;
  const avg = values.length ? average(values) : 0;
  const normalized = normalizeMetricPercent(metric, avg);

  const thresholds = { warning: 70, critical: 90 };
  const status = normalized >= thresholds.critical ? "critical" : normalized >= thresholds.warning ? "warning" : "healthy";

  return {
    metric,
    range,
    value: current,
    average: avg,
    normalized,
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
    thresholds,
    status,
  };
}

export async function getMetricHeatmap(endpointId: string, input: {
  metric: string;
  from?: string;
  to?: string;
  namespace?: string;
  pod?: string;
  node?: string;
  stepSeconds?: number;
  limit?: number;
}) {
  const stepSeconds = Math.min(300, Math.max(1, input.stepSeconds ?? 5));
  const { range, rows } = await queryMetricSeriesRows(endpointId, input.metric, input, input.limit ?? 30000);
  const buckets = new Map<string, number[]>();

  for (const row of rows) {
    const pod = row.labels?.pod ?? "unknown";
    const ts = new Date(floorToStep(Date.parse(row.timestamp), stepSeconds)).toISOString();
    const key = `${ts}||${pod}`;
    const values = buckets.get(key) ?? [];
    values.push(Number(row.value));
    buckets.set(key, values);
  }

  const points = Array.from(buckets.entries()).map(([key, values]) => {
    const [timestamp, pod] = key.split("||");
    return {
      timestamp,
      pod,
      value: average(values),
      density: values.length,
    };
  });

  points.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  return {
    metric: input.metric,
    stepSeconds,
    range,
    points,
  };
}

export async function getMetricHistogram(endpointId: string, input: HistogramInput) {
  const bins = Math.min(50, Math.max(5, input.bins ?? 12));
  const { range, rows } = await queryMetricSeriesRows(endpointId, input.metric, input, 30000);
  const values = rows.map((r) => Number(r.value)).filter((v) => Number.isFinite(v));

  if (!values.length) {
    return {
      metric: input.metric,
      range,
      bins,
      buckets: [] as Array<{ bucket_start: number; bucket_end: number; count: number }>,
    };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = Math.max(1e-9, (max - min) / bins);

  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.floor((v - min) / width));
    counts[idx] += 1;
  }

  const buckets = counts.map((count, idx) => ({
    bucket_start: min + idx * width,
    bucket_end: min + (idx + 1) * width,
    count,
  }));

  return {
    metric: input.metric,
    range,
    bins,
    buckets,
  };
}

export async function getPodsDetails(endpointId: string, input: PodsDetailsInput) {
  const admin = createSupabaseAdminClient();
  const from = toIso(input.from, new Date(Date.now() - 30 * 60_000).toISOString());
  const to = toIso(input.to);
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50));

  let query = admin
    .from("metrics_snapshots")
    .select("pod_name,namespace,status,cpu_usage,memory_usage,restart_count,timestamp")
    .eq("endpoint_id", endpointId)
    .gte("timestamp", from)
    .lte("timestamp", to)
    .order("timestamp", { ascending: false })
    .limit(5000);

  if (input.namespace) query = query.eq("namespace", input.namespace);
  if (input.pod) query = query.eq("pod_name", input.pod);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const latest = new Map<string, {
    pod: string;
    namespace: string;
    status: string;
    cpu: number;
    memory: number;
    restarts: number;
    timestamp: string;
    health_score: number;
  }>();

  for (const row of data ?? []) {
    const key = `${row.namespace}/${row.pod_name}`;
    if (latest.has(key)) continue;
    const cpu = typeof row.cpu_usage === "number" ? row.cpu_usage : 0;
    const memory = typeof row.memory_usage === "number" ? row.memory_usage : 0;
    const restarts = row.restart_count ?? 0;
    latest.set(key, {
      pod: row.pod_name,
      namespace: row.namespace,
      status: row.status,
      cpu,
      memory,
      restarts,
      timestamp: row.timestamp,
      health_score: healthScore(cpu, memory, restarts, row.status),
    });
  }

  let rows = Array.from(latest.values());

  if (input.status) {
    const wanted = input.status.toLowerCase();
    rows = rows.filter((r) => r.status.toLowerCase().includes(wanted));
  }
  if (input.search) {
    const q = input.search.toLowerCase();
    rows = rows.filter((r) => r.pod.toLowerCase().includes(q) || r.namespace.toLowerCase().includes(q));
  }

  const sortBy = input.sortBy ?? "health_score";
  const order = input.order === "asc" ? 1 : -1;

  rows.sort((a, b) => {
    if (sortBy === "pod") return a.pod.localeCompare(b.pod) * order;
    if (sortBy === "namespace") return a.namespace.localeCompare(b.namespace) * order;
    if (sortBy === "status") return a.status.localeCompare(b.status) * order;
    if (sortBy === "cpu") return (a.cpu - b.cpu) * order;
    if (sortBy === "memory") return (a.memory - b.memory) * order;
    if (sortBy === "restarts") return (a.restarts - b.restarts) * order;
    return (a.health_score - b.health_score) * order;
  });

  const total = rows.length;
  const start = (page - 1) * pageSize;
  const paged = rows.slice(start, start + pageSize);

  return {
    range: { from, to },
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
    rows: paged,
  };
}

export async function getPodsStateTimeline(endpointId: string, input: StateTimelineInput) {
  const admin = createSupabaseAdminClient();
  const from = toIso(input.from, new Date(Date.now() - 60 * 60_000).toISOString());
  const to = toIso(input.to);
  const stepSeconds = Math.min(300, Math.max(1, input.stepSeconds ?? 30));
  const limit = Math.min(20000, Math.max(100, input.limit ?? 5000));

  let query = admin
    .from("metrics_snapshots")
    .select("pod_name,namespace,status,timestamp")
    .eq("endpoint_id", endpointId)
    .gte("timestamp", from)
    .lte("timestamp", to)
    .order("timestamp", { ascending: true })
    .limit(limit);

  if (input.namespace) query = query.eq("namespace", input.namespace);
  if (input.pod) query = query.eq("pod_name", input.pod);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const points = (data ?? []).map((row) => ({
    timestamp: new Date(floorToStep(Date.parse(row.timestamp), stepSeconds)).toISOString(),
    pod: row.pod_name,
    namespace: row.namespace,
    state: row.status,
  }));

  return {
    range: { from, to },
    stepSeconds,
    total: points.length,
    points,
  };
}
