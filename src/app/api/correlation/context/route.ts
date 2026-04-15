import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserAndEndpoint, toHttpStatus } from "@/lib/observability/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { queryLogs } from "@/lib/observability/logs";

const QuerySchema = z.object({
  endpoint: z.string().uuid(),
  timestamp: z.string().datetime().optional(),
  windowSeconds: z.coerce.number().int().min(30).max(3600).optional(),
  namespace: z.string().optional(),
  pod: z.string().optional(),
  node: z.string().optional(),
  metric: z.string().optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    endpoint: url.searchParams.get("endpoint"),
    timestamp: url.searchParams.get("timestamp") || undefined,
    windowSeconds: url.searchParams.get("windowSeconds") || undefined,
    namespace: url.searchParams.get("namespace") || undefined,
    pod: url.searchParams.get("pod") || undefined,
    node: url.searchParams.get("node") || undefined,
    metric: url.searchParams.get("metric") || undefined,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    await requireUserAndEndpoint(parsed.data.endpoint);

    const baseTs = parsed.data.timestamp ? new Date(parsed.data.timestamp) : new Date();
    const windowSeconds = parsed.data.windowSeconds ?? 300;
    const from = new Date(baseTs.getTime() - windowSeconds * 1000).toISOString();
    const to = new Date(baseTs.getTime() + windowSeconds * 1000).toISOString();

    const admin = createSupabaseAdminClient();

    let metricsQuery = admin
      .from("metrics_series")
      .select("metric_name,labels,value,timestamp")
      .eq("endpoint_id", parsed.data.endpoint)
      .gte("timestamp", from)
      .lte("timestamp", to)
      .order("timestamp", { ascending: false })
      .limit(800);

    if (parsed.data.metric) metricsQuery = metricsQuery.eq("metric_name", parsed.data.metric);
    if (parsed.data.namespace) metricsQuery = metricsQuery.filter("labels->>namespace", "eq", parsed.data.namespace);
    if (parsed.data.pod) metricsQuery = metricsQuery.filter("labels->>pod", "eq", parsed.data.pod);
    if (parsed.data.node) metricsQuery = metricsQuery.filter("labels->>node", "eq", parsed.data.node);

    const [{ data: metrics, error: metricsErr }, { data: alerts, error: alertsErr }, { data: events, error: eventsErr }, logsResult] = await Promise.all([
      metricsQuery,
      admin
        .from("alert_state_history")
        .select("id,rule_key,state,value,message,timestamp")
        .eq("endpoint_id", parsed.data.endpoint)
        .gte("timestamp", from)
        .lte("timestamp", to)
        .order("timestamp", { ascending: false })
        .limit(300),
      admin
        .from("observability_events")
        .select("id,correlation_id,event_type,severity,title,details,timestamp")
        .eq("endpoint_id", parsed.data.endpoint)
        .gte("timestamp", from)
        .lte("timestamp", to)
        .order("timestamp", { ascending: false })
        .limit(300),
      queryLogs({
        endpoint_id: parsed.data.endpoint,
        namespace: parsed.data.namespace,
        pod: parsed.data.pod,
        node: parsed.data.node,
        from,
        to,
        limit: 500,
      }),
    ]);

    if (metricsErr) throw new Error(metricsErr.message);
    if (alertsErr) throw new Error(alertsErr.message);
    if (eventsErr) throw new Error(eventsErr.message);

    return NextResponse.json(
      {
        ok: true,
        range: { from, to, anchor: baseTs.toISOString(), windowSeconds },
        metrics: metrics ?? [],
        logs: logsResult.logs,
        alerts: alerts ?? [],
        events: events ?? [],
      },
      { headers: { "Cache-Control": "private, max-age=3" } },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: toHttpStatus(error) },
    );
  }
}
