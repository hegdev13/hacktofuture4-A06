import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchClusterSnapshot } from "@/lib/kube/fetch-metrics";
import { NgrokUrlSchema } from "@/lib/validation";
import { rateLimit } from "@/lib/security/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { analyzeSnapshotWithAiAgent } from "@/lib/ai-agents";
import { publishObservabilityEvent } from "@/lib/observability/events";

const QuerySchema = z
  .object({
    endpoint: z.string().uuid().optional(),
    ngrok_url: NgrokUrlSchema.optional(),
  })
  .refine((v) => Boolean(v.endpoint || v.ngrok_url), {
    message: "endpoint or ngrok_url is required",
  });

export async function GET(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = rateLimit({ key: `aianalyze:${ip}`, limit: 60, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited", resetAt: rl.resetAt }, { status: 429 });
  }

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    endpoint: url.searchParams.get("endpoint") || undefined,
    ngrok_url: url.searchParams.get("ngrok_url") || undefined,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let ngrokUrl = parsed.data.ngrok_url;
  if (!ngrokUrl && parsed.data.endpoint) {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { data: endpoint, error } = await supabase
      .from("endpoints")
      .select("id,ngrok_url")
      .eq("id", parsed.data.endpoint)
      .eq("user_id", user.id)
      .single();

    if (error || !endpoint) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const ngrokParsed = NgrokUrlSchema.safeParse(endpoint.ngrok_url);
    if (!ngrokParsed.success) {
      return NextResponse.json({ error: "invalid_upstream" }, { status: 500 });
    }
    ngrokUrl = ngrokParsed.data;
  }

  if (!ngrokUrl) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const snapshot = await fetchClusterSnapshot(ngrokUrl);
    const analysis = analyzeSnapshotWithAiAgent(snapshot);

    if (parsed.data.endpoint) {
      await publishObservabilityEvent({
        endpoint_id: parsed.data.endpoint,
        event_type: "ai_detection",
        related_resource: analysis.root_cause,
        related_kind: "service",
        severity: analysis.status === "critical" ? "critical" : analysis.status === "degraded" ? "warning" : "info",
        title: `AI analyze: ${analysis.root_cause}`,
        details: {
          confidence: analysis.confidence,
          summary: analysis.summary,
          status: analysis.status,
          healthPercent: analysis.healthPercent,
        },
      });
    }

    return NextResponse.json({ ok: true, analysis });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
