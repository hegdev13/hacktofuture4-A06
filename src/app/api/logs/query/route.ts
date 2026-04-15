import { NextResponse } from "next/server";
import { z } from "zod";
import { queryLogs } from "@/lib/observability/logs";
import { requireUserAndEndpoint, toHttpStatus } from "@/lib/observability/auth";

const QuerySchema = z.object({
  endpoint: z.string().uuid(),
  namespace: z.string().optional(),
  pod: z.string().optional(),
  node: z.string().optional(),
  container: z.string().optional(),
  search: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    endpoint: url.searchParams.get("endpoint"),
    namespace: url.searchParams.get("namespace") || undefined,
    pod: url.searchParams.get("pod") || undefined,
    node: url.searchParams.get("node") || undefined,
    container: url.searchParams.get("container") || undefined,
    search: url.searchParams.get("search") || undefined,
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    startTime: url.searchParams.get("startTime") || undefined,
    endTime: url.searchParams.get("endTime") || undefined,
    limit: url.searchParams.get("limit") || undefined,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    await requireUserAndEndpoint(parsed.data.endpoint);
    const data = await queryLogs({
      endpoint_id: parsed.data.endpoint,
      namespace: parsed.data.namespace,
      pod: parsed.data.pod,
      node: parsed.data.node,
      container: parsed.data.container,
      search: parsed.data.search,
      from: parsed.data.startTime ?? parsed.data.from,
      to: parsed.data.endTime ?? parsed.data.to,
      limit: parsed.data.limit,
    });
    return NextResponse.json(
      { ok: true, ...data },
      {
        headers: {
          "Cache-Control": "private, max-age=3",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: toHttpStatus(error) },
    );
  }
}
