import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { rateLimit } from "@/lib/security/rate-limit";
import { publishObservabilityEvent } from "@/lib/observability/events";

const BodySchema = z.object({
  endpoint_id: z.string().uuid(),
  action_taken: z.string().min(2).max(500),
  status: z.enum(["success", "failure"]),
  timestamp: z.string().datetime().optional(),
});

export async function POST(request: Request) {
  const secret = request.headers.get("x-kubepulse-secret");
  if (!process.env.METRICS_POLL_SECRET || secret !== process.env.METRICS_POLL_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = rateLimit({ key: `heal:${ip}`, limit: 120, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("healing_actions").insert({
    endpoint_id: parsed.data.endpoint_id,
    action_taken: parsed.data.action_taken,
    status: parsed.data.status,
    timestamp: parsed.data.timestamp ?? new Date().toISOString(),
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await publishObservabilityEvent({
    endpoint_id: parsed.data.endpoint_id,
    event_type: parsed.data.status === "success" ? "resolution" : "ai_action",
    severity: parsed.data.status === "success" ? "info" : "warning",
    title: parsed.data.action_taken,
    details: { status: parsed.data.status },
    timestamp: parsed.data.timestamp,
  });

  return NextResponse.json({ ok: true });
}

