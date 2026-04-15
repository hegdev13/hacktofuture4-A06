import { z } from "zod";
import { queryLogs } from "@/lib/observability/logs";
import { requireUserAndEndpoint } from "@/lib/observability/auth";

export const runtime = "nodejs";

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
});

function sseMessage(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

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
  });

  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "invalid_request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    await requireUserAndEndpoint(parsed.data.endpoint);
  } catch {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const initialFrom = parsed.data.startTime ?? parsed.data.from;
      const initialTo = parsed.data.endTime ?? parsed.data.to;
      let lastTs = initialFrom ?? new Date(Date.now() - 10_000).toISOString();

      const send = (event: string, payload: unknown) => {
        controller.enqueue(encoder.encode(sseMessage(event, payload)));
      };

      const poll = async () => {
        const result = await queryLogs({
          endpoint_id: parsed.data.endpoint,
          namespace: parsed.data.namespace,
          pod: parsed.data.pod,
          node: parsed.data.node,
          container: parsed.data.container,
          search: parsed.data.search,
          from: lastTs,
          to: initialTo ?? new Date().toISOString(),
          limit: 200,
        });

        const ordered = [...result.logs].reverse();
        if (ordered.length) {
          lastTs = ordered[ordered.length - 1].timestamp;
          send("logs", ordered);
        }
      };

      const tick = setInterval(() => {
        void poll();
      }, 2000);

      const heartbeat = setInterval(() => {
        send("ping", { timestamp: new Date().toISOString() });
      }, 15000);

      void poll();

      request.signal.addEventListener("abort", () => {
        clearInterval(tick);
        clearInterval(heartbeat);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
