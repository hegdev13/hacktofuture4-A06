import { NextResponse } from "next/server";
import { z } from "zod";
import { getMetricHistogram } from "@/lib/observability/metrics";
import { requireUserAndEndpoint, toHttpStatus } from "@/lib/observability/auth";

const QuerySchema = z.object({
  endpoint: z.string().uuid(),
  metric: z.string().min(1),
  bins: z.coerce.number().int().min(5).max(50).optional(),
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
    bins: url.searchParams.get("bins") || undefined,
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
    const result = await getMetricHistogram(parsed.data.endpoint, {
      metric: parsed.data.metric,
      bins: parsed.data.bins,
      from: parsed.data.startTime ?? parsed.data.from,
      to: parsed.data.endTime ?? parsed.data.to,
      namespace: parsed.data.namespace,
      pod: parsed.data.pod,
      node: parsed.data.node,
    });

    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": "private, max-age=10" } },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: toHttpStatus(error) },
    );
  }
}
