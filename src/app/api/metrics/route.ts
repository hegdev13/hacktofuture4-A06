import { NextResponse } from "next/server";
import { z } from "zod";
import { queryPromLikeMetrics } from "@/lib/observability/metrics";
import { requireUserAndEndpoint, toHttpStatus } from "@/lib/observability/auth";

const QuerySchema = z.object({
  endpoint: z.string().uuid(),
  query: z.string().min(1),
  groupBy: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  step: z.coerce.number().int().min(1).max(3600).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    endpoint: url.searchParams.get("endpoint"),
    query: url.searchParams.get("query"),
    groupBy: url.searchParams.get("groupBy") || undefined,
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    step: url.searchParams.get("step") || undefined,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    await requireUserAndEndpoint(parsed.data.endpoint);
    const result = await queryPromLikeMetrics(parsed.data.endpoint, {
      query: parsed.data.query,
      groupBy: parsed.data.groupBy,
      from: parsed.data.from,
      to: parsed.data.to,
      stepSeconds: parsed.data.step,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: toHttpStatus(error) },
    );
  }
}
