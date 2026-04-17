import { healingRunnerService } from "@/lib/healing/agent-runner";

export const runtime = "nodejs";

function sseMessage(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: Request) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (event: string, payload: unknown) => {
        if (typeof payload === "undefined") {
          return;
        }
        controller.enqueue(encoder.encode(sseMessage(event, payload)));
      };

      const unsubscribe = healingRunnerService.subscribe((evt) => {
        send(evt.type, evt.payload);
      });

      const heartbeat = setInterval(() => {
        send("ping", { timestamp: new Date().toISOString() });
      }, 15000);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
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
