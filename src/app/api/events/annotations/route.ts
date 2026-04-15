import { NextResponse } from "next/server";
import { z } from "zod";
import { getTimeline } from "@/lib/observability/events";
import { requireUserAndEndpoint, toHttpStatus } from "@/lib/observability/auth";

const QuerySchema = z.object({
  endpoint: z.string().uuid(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  types: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    endpoint: url.searchParams.get("endpoint"),
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    startTime: url.searchParams.get("startTime") || undefined,
    endTime: url.searchParams.get("endTime") || undefined,
    types: url.searchParams.get("types") || undefined,
    limit: url.searchParams.get("limit") || undefined,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    await requireUserAndEndpoint(parsed.data.endpoint);
    const timeline = await getTimeline({
      endpoint_id: parsed.data.endpoint,
      from: parsed.data.startTime ?? parsed.data.from,
      to: parsed.data.endTime ?? parsed.data.to,
      types: parsed.data.types ? parsed.data.types.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      limit: parsed.data.limit,
    });

    const annotations = timeline.events.map((ev) => ({
      id: String(ev.id ?? ""),
      timestamp: String(ev.timestamp ?? ""),
      title: String(ev.title ?? "Event"),
      text: String(ev.title ?? "Event"),
      severity: String(ev.severity ?? "info"),
      event_type: String(ev.event_type ?? "system"),
      tags: [String(ev.event_type ?? "system"), String(ev.severity ?? "info")],
      correlation_id: ev.correlation_id ?? null,
    }));

    return NextResponse.json(
      { ok: true, range: timeline.range, total: annotations.length, annotations },
      { headers: { "Cache-Control": "private, max-age=5" } },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: toHttpStatus(error) },
    );
  }
}
