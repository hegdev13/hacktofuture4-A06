import { NextResponse } from "next/server";
import { z } from "zod";
import { getTopMetrics } from "@/lib/observability/metrics";
import { requireUserAndEndpoint, toHttpStatus } from "@/lib/observability/auth";

const QuerySchema = z.object({
  endpoint: z.string().uuid(),
  metric: z.string().min(1),
  groupBy: z.string().optional(),
  aggregation: z.enum(["sum", "avg", "min", "max"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.enum(["asc", "desc"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  namespace: z.string().optional(),
  pod: z.string().optional(),
  node: z.string().optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    endpoint: url.searchParams.get("endpoint"),
    metric: url.searchParams.get("metric"),
    groupBy: url.searchParams.get("groupBy") || undefined,
    aggregation: url.searchParams.get("aggregation") || undefined,
    limit: url.searchParams.get("limit") || undefined,
    sort: url.searchParams.get("sort") || undefined,
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    startTime: url.searchParams.get("startTime") || undefined,
    endTime: url.searchParams.get("endTime") || undefined,
    namespace: url.searchParams.get("namespace") || undefined,
    pod: url.searchParams.get("pod") || undefined,
    node: url.searchParams.get("node") || undefined,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    await requireUserAndEndpoint(parsed.data.endpoint);
    const result = await getTopMetrics(parsed.data.endpoint, {
      metric: parsed.data.metric,
      groupBy: parsed.data.groupBy,
      aggregation: parsed.data.aggregation,
      limit: parsed.data.limit,
      sort: parsed.data.sort,
      from: parsed.data.startTime ?? parsed.data.from,
      to: parsed.data.endTime ?? parsed.data.to,
      namespace: parsed.data.namespace,
      pod: parsed.data.pod,
      node: parsed.data.node,
    });

    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": "private, max-age=5" } },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: toHttpStatus(error) },
    );
  }
}
