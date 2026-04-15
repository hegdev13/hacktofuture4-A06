import { NextResponse } from "next/server";
import { z } from "zod";
import { getPodsDetails } from "@/lib/observability/metrics";
import { requireUserAndEndpoint, toHttpStatus } from "@/lib/observability/auth";

const QuerySchema = z.object({
  endpoint: z.string().uuid(),
  namespace: z.string().optional(),
  pod: z.string().optional(),
  status: z.string().optional(),
  search: z.string().optional(),
  sortBy: z.enum(["pod", "namespace", "status", "cpu", "memory", "restarts", "health_score"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    endpoint: url.searchParams.get("endpoint"),
    namespace: url.searchParams.get("namespace") || undefined,
    pod: url.searchParams.get("pod") || undefined,
    status: url.searchParams.get("status") || undefined,
    search: url.searchParams.get("search") || undefined,
    sortBy: url.searchParams.get("sortBy") || undefined,
    order: url.searchParams.get("order") || undefined,
    page: url.searchParams.get("page") || undefined,
    pageSize: url.searchParams.get("pageSize") || undefined,
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    startTime: url.searchParams.get("startTime") || undefined,
    endTime: url.searchParams.get("endTime") || undefined,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    await requireUserAndEndpoint(parsed.data.endpoint);
    const result = await getPodsDetails(parsed.data.endpoint, {
      namespace: parsed.data.namespace,
      pod: parsed.data.pod,
      status: parsed.data.status,
      search: parsed.data.search,
      sortBy: parsed.data.sortBy,
      order: parsed.data.order,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      from: parsed.data.startTime ?? parsed.data.from,
      to: parsed.data.endTime ?? parsed.data.to,
    });

    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": "private, max-age=5" } },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: toHttpStatus(error) },
    );
  }
}
