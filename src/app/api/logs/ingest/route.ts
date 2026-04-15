import { NextResponse } from "next/server";
import { z } from "zod";
import { ingestLogs } from "@/lib/observability/logs";

const BodySchema = z.object({
  entries: z.array(
    z.object({
      endpoint_id: z.string().uuid().optional(),
      timestamp: z.string().datetime().optional(),
      labels: z.record(z.string()),
      message: z.string().min(1),
      source: z.enum(["pod", "container", "agent", "system"]).optional(),
      level: z.string().optional(),
      correlation_id: z.string().optional(),
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
    const result = await ingestLogs(parsed.data.entries);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
