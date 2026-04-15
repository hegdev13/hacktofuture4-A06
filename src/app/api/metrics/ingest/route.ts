import { NextResponse } from "next/server";
import { z } from "zod";
import { ingestPushedMetrics } from "@/lib/observability/metrics";

const BodySchema = z.object({
  endpoint_id: z.string().uuid(),
  metrics: z.array(
    z.object({
      metric_name: z.string().min(1),
      labels: z.record(z.string()).optional(),
      value: z.number(),
      timestamp: z.string().datetime().optional(),
    }),
  ).min(1),
});

export async function POST(request: Request) {
  const secret = request.headers.get("x-kubepulse-secret");
  if (!process.env.METRICS_POLL_SECRET || secret !== process.env.METRICS_POLL_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const result = await ingestPushedMetrics(parsed.data);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
