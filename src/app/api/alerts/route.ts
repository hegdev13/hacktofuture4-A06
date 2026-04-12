import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/security/rate-limit";

const QuerySchema = z.object({
  endpoint: z.string().uuid(),
});

export async function GET(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = rateLimit({ key: `alerts:${ip}`, limit: 120, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited", resetAt: rl.resetAt }, { status: 429 });
  }

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({ endpoint: url.searchParams.get("endpoint") });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [{ data: alerts, error: alertsErr }, { data: healingActions, error: healingErr }] =
    await Promise.all([
      supabase
        .from("alerts")
        .select("id,endpoint_id,message,severity,created_at")
        .eq("endpoint_id", parsed.data.endpoint)
        .order("created_at", { ascending: false })
        .limit(80),
      supabase
        .from("healing_actions")
        .select("id,endpoint_id,action_taken,status,timestamp")
        .eq("endpoint_id", parsed.data.endpoint)
        .order("timestamp", { ascending: false })
        .limit(80),
    ]);

  if (alertsErr) {
    return NextResponse.json({ error: alertsErr.message }, { status: 500 });
  }

  if (healingErr) {
    return NextResponse.json({ error: healingErr.message }, { status: 500 });
  }

  return NextResponse.json({
    alerts: alerts ?? [],
    healing_actions: healingActions ?? [],
  });
}
