import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchClusterSnapshot } from "@/lib/kube/fetch-metrics";
import { analyzeSnapshotWithAiAgent } from "@/lib/ai-agents";
import { requireUserAndEndpoint, toHttpStatus } from "@/lib/observability/auth";
import { publishObservabilityEvent } from "@/lib/observability/events";

const QuerySchema = z.object({
  endpoint: z.string().uuid(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({ endpoint: url.searchParams.get("endpoint") });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const { endpoint } = await requireUserAndEndpoint(parsed.data.endpoint);
    const snapshot = await fetchClusterSnapshot(endpoint.ngrok_url);
    const analysis = analyzeSnapshotWithAiAgent(snapshot);

    await publishObservabilityEvent({
      endpoint_id: endpoint.id,
      event_type: "ai_detection",
      related_resource: analysis.root_cause,
      related_kind: "service",
      severity: analysis.status === "critical" ? "critical" : analysis.status === "degraded" ? "warning" : "info",
      title: `AI analysis: ${analysis.root_cause}`,
      details: {
        confidence: analysis.confidence,
        summary: analysis.summary,
      },
    });

    return NextResponse.json({ ok: true, analysis });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: toHttpStatus(error) },
    );
  }
}
