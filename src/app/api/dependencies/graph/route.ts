import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserAndEndpoint, toHttpStatus } from "@/lib/observability/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildDependencyImpact } from "@/lib/observability/dependency";

const QuerySchema = z.object({
  endpoint: z.string().uuid(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  namespace: z.string().optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    endpoint: url.searchParams.get("endpoint"),
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    startTime: url.searchParams.get("startTime") || undefined,
    endTime: url.searchParams.get("endTime") || undefined,
    namespace: url.searchParams.get("namespace") || undefined,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    await requireUserAndEndpoint(parsed.data.endpoint);

    const admin = createSupabaseAdminClient();
    const from = parsed.data.startTime ?? parsed.data.from ?? new Date(Date.now() - 15 * 60_000).toISOString();
    const to = parsed.data.endTime ?? parsed.data.to ?? new Date().toISOString();

    let query = admin
      .from("metrics_snapshots")
      .select("pod_name,namespace,status,cpu_usage,memory_usage,restart_count,timestamp")
      .eq("endpoint_id", parsed.data.endpoint)
      .gte("timestamp", from)
      .lte("timestamp", to)
      .order("timestamp", { ascending: false })
      .limit(5000);

    if (parsed.data.namespace) query = query.eq("namespace", parsed.data.namespace);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const latestByPod = new Map<string, {
      pod_name: string;
      namespace: string;
      status: string;
      cpu_usage: number | null;
      memory_usage: number | null;
      restart_count: number;
    }>();

    for (const row of data ?? []) {
      const key = `${row.namespace}/${row.pod_name}`;
      if (latestByPod.has(key)) continue;
      latestByPod.set(key, {
        pod_name: row.pod_name,
        namespace: row.namespace,
        status: row.status,
        cpu_usage: row.cpu_usage,
        memory_usage: row.memory_usage,
        restart_count: row.restart_count ?? 0,
      });
    }

    const snapshot = {
      fetched_at: new Date().toISOString(),
      pods: Array.from(latestByPod.values()),
    };

    const analysis = buildDependencyImpact(snapshot);

    const nodes = analysis.graphPods.map((p) => ({
      id: p.id,
      label: p.name,
      health: p.healthScore,
      status: p.status,
      failureType: p.failureType,
      failureReason: p.failureReason,
    }));

    const edges = analysis.graphPods.flatMap((p) =>
      p.dependsOn.map((dep) => ({
        source: dep,
        target: p.id,
        weight: Math.max(1, Math.round((100 - p.healthScore) / 20) + 1),
      })),
    );

    return NextResponse.json(
      {
        ok: true,
        range: { from, to },
        nodes,
        edges,
        root_cause: analysis.root_cause,
        confidence: analysis.confidence,
        status: analysis.status,
        healthPercent: analysis.healthPercent,
      },
      { headers: { "Cache-Control": "private, max-age=5" } },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: toHttpStatus(error) },
    );
  }
}
