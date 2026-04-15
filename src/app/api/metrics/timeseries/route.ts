import { NextResponse } from "next/server";
import { z } from "zod";
import { queryPromLikeMetrics } from "@/lib/observability/metrics";
import { requireUserAndEndpoint, toHttpStatus } from "@/lib/observability/auth";

const QuerySchema = z.object({
  endpoint: z.string().uuid(),
  query: z.string().min(1).optional(),
  metric: z.string().min(1).optional(),
  groupBy: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  namespace: z.string().optional(),
  pod: z.string().optional(),
  node: z.string().optional(),
  step: z.coerce.number().int().min(1).max(3600).optional(),
  limit: z.coerce.number().int().min(100).max(10000).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    endpoint: url.searchParams.get("endpoint"),
    query: url.searchParams.get("query") || undefined,
    metric: url.searchParams.get("metric") || undefined,
    groupBy: url.searchParams.get("groupBy") || undefined,
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    startTime: url.searchParams.get("startTime") || undefined,
    endTime: url.searchParams.get("endTime") || undefined,
    namespace: url.searchParams.get("namespace") || undefined,
    pod: url.searchParams.get("pod") || undefined,
    node: url.searchParams.get("node") || undefined,
    step: url.searchParams.get("step") || undefined,
    limit: url.searchParams.get("limit") || undefined,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    await requireUserAndEndpoint(parsed.data.endpoint);
    const expression = parsed.data.query ?? parsed.data.metric;
    if (!expression) {
      return NextResponse.json({ error: "query_or_metric_required" }, { status: 400 });
    }

    const from = parsed.data.startTime ?? parsed.data.from;
    const to = parsed.data.endTime ?? parsed.data.to;

    const result = await queryPromLikeMetrics(parsed.data.endpoint, {
      query: expression,
      groupBy: parsed.data.groupBy,
      from,
      to,
      namespace: parsed.data.namespace,
      pod: parsed.data.pod,
      node: parsed.data.node,
      stepSeconds: parsed.data.step,
      limit: parsed.data.limit,
    });

    const rows = result.series.flatMap((s) => {
      const group = parsed.data.groupBy ? s.labels?.[parsed.data.groupBy] ?? "unknown" : "all";
      return s.points.map((p) => ({
        timestamp: p.timestamp,
        group,
        value: p.value,
      }));
    });

    return NextResponse.json(
      { ok: true, ...result, rows },
      {
        headers: {
          "Cache-Control": "private, max-age=5",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: toHttpStatus(error) },
    );
  }
}
