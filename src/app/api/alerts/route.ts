import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/security/rate-limit";

const QuerySchema = z.object({
  endpoint: z.string().uuid(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  severity: z.enum(["low", "medium", "high"]).optional(),
  state: z.enum(["pending", "firing", "resolved"]).optional(),
});

export async function GET(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = rateLimit({ key: `alerts:${ip}`, limit: 120, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited", resetAt: rl.resetAt }, { status: 429 });
  }

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    endpoint: url.searchParams.get("endpoint"),
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    startTime: url.searchParams.get("startTime") || undefined,
    endTime: url.searchParams.get("endTime") || undefined,
    severity: url.searchParams.get("severity") || undefined,
    state: url.searchParams.get("state") || undefined,
  });
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

  const from = parsed.data.startTime ?? parsed.data.from ?? new Date(Date.now() - 60 * 60_000).toISOString();
  const to = parsed.data.endTime ?? parsed.data.to ?? new Date().toISOString();

  let alertsQuery = supabase
    .from("alerts")
    .select("id,endpoint_id,message,severity,created_at")
    .eq("endpoint_id", parsed.data.endpoint)
    .gte("created_at", from)
    .lte("created_at", to)
    .order("created_at", { ascending: false })
    .limit(80);

  if (parsed.data.severity) alertsQuery = alertsQuery.eq("severity", parsed.data.severity);

  let stateQuery = supabase
    .from("alert_states")
    .select("rule_key,state,state_since,last_value,updated_at")
    .eq("endpoint_id", parsed.data.endpoint)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (parsed.data.state) stateQuery = stateQuery.eq("state", parsed.data.state);

  const [
    { data: alerts, error: alertsErr },
    { data: healingActions, error: healingErr },
    { data: states, error: statesErr },
    { data: stateHistory, error: histErr },
  ] =
    await Promise.all([
      alertsQuery,
      supabase
        .from("healing_actions")
        .select("id,endpoint_id,action_taken,status,timestamp")
        .eq("endpoint_id", parsed.data.endpoint)
        .order("timestamp", { ascending: false })
        .limit(80),
      stateQuery,
      supabase
        .from("alert_state_history")
        .select("id,rule_key,state,value,message,timestamp")
        .eq("endpoint_id", parsed.data.endpoint)
        .gte("timestamp", from)
        .lte("timestamp", to)
        .order("timestamp", { ascending: false })
        .limit(200),
    ]);

  if (alertsErr) {
    return NextResponse.json({ error: alertsErr.message }, { status: 500 });
  }

  if (healingErr) {
    return NextResponse.json({ error: healingErr.message }, { status: 500 });
  }

  if (statesErr) {
    return NextResponse.json({ error: statesErr.message }, { status: 500 });
  }

  if (histErr) {
    return NextResponse.json({ error: histErr.message }, { status: 500 });
  }

  return NextResponse.json({
    range: { from, to },
    alerts: alerts ?? [],
    healing_actions: healingActions ?? [],
    alert_states: states ?? [],
    alert_history: stateHistory ?? [],
  }, {
    headers: {
      "Cache-Control": "private, max-age=5",
    },
  });
}
