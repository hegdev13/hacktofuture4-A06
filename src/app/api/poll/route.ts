import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchClusterSnapshot } from "@/lib/kube/fetch-metrics";
import { NgrokUrlSchema } from "@/lib/validation";
import { rateLimit } from "@/lib/security/rate-limit";

const BodySchema = z.object({
  endpoint_id: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  const secret = request.headers.get("x-kubepulse-secret");
  if (!process.env.METRICS_POLL_SECRET || secret !== process.env.METRICS_POLL_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = rateLimit({ key: `poll:${ip}`, limit: 30, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", resetAt: rl.resetAt },
      { status: 429 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const parsedBody = BodySchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();

  const endpointsQuery = admin
    .from("endpoints")
    .select("id,ngrok_url")
    .order("created_at", { ascending: false });

  const { data: endpoints, error: endpointsErr } = parsedBody.data.endpoint_id
    ? await endpointsQuery.eq("id", parsedBody.data.endpoint_id)
    : await endpointsQuery;

  if (endpointsErr) {
    return NextResponse.json({ error: endpointsErr.message }, { status: 500 });
  }

  const results: Array<{ endpoint_id: string; ok: boolean; error?: string }> = [];

  for (const ep of endpoints ?? []) {
    const ngrokParsed = NgrokUrlSchema.safeParse(ep.ngrok_url);
    if (!ngrokParsed.success) {
      results.push({ endpoint_id: ep.id, ok: false, error: "Invalid ngrok_url in DB" });
      continue;
    }

    try {
      const snapshot = await fetchClusterSnapshot(ngrokParsed.data);

      const rows = snapshot.pods.map((p) => ({
        endpoint_id: ep.id,
        pod_name: p.pod_name,
        namespace: p.namespace ?? "default",
        status: p.status,
        cpu_usage: p.cpu_usage ?? null,
        memory_usage: p.memory_usage ?? null,
        restart_count: p.restart_count ?? 0,
        timestamp: new Date().toISOString(),
      }));

      if (rows.length) {
        const { error: insertErr } = await admin.from("metrics_snapshots").insert(rows);
        if (insertErr) throw insertErr;
      }

      const alerts: Array<{ endpoint_id: string; message: string; severity: "low" | "medium" | "high" }> = [];
      for (const p of snapshot.pods) {
        const status = p.status.toLowerCase();
        const restarts = p.restart_count ?? 0;
        if (status.includes("crashloop") || status.includes("error") || status.includes("failed")) {
          alerts.push({
            endpoint_id: ep.id,
            severity: "high",
            message: `${p.namespace ?? "default"}/${p.pod_name} is ${p.status}`,
          });
        } else if (restarts >= 3) {
          alerts.push({
            endpoint_id: ep.id,
            severity: "medium",
            message: `${p.namespace ?? "default"}/${p.pod_name} restart spike: ${restarts}`,
          });
        }
      }
      if (alerts.length) {
        const { error: alertErr } = await admin.from("alerts").insert(
          alerts.map((a) => ({ ...a, created_at: new Date().toISOString() })),
        );
        if (alertErr) throw alertErr;
      }

      results.push({ endpoint_id: ep.id, ok: true });
    } catch (e) {
      results.push({
        endpoint_id: ep.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json({ ok: true, results });
}

