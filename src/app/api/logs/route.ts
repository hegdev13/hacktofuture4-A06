import { NextResponse } from "next/server";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NgrokUrlSchema } from "@/lib/validation";
import { rateLimit } from "@/lib/security/rate-limit";
import { ingestLogs, queryLogs } from "@/lib/observability/logs";
import { publishObservabilityEvent } from "@/lib/observability/events";

export const runtime = "nodejs";

const QuerySchema = z.object({
  endpoint: z.string().uuid().optional(),
  ngrok_url: NgrokUrlSchema.optional(),
  pod: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
  container: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
}).refine((v) => Boolean(v.endpoint || v.ngrok_url), {
  message: "endpoint or ngrok_url is required",
});

function joinUrl(base: string, path: string) {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

function normalizeNgrokBase(input: string) {
  const u = new URL(input);
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const stripIfExact = new Set([
    "/pods",
    "/api/pods",
    "/metrics",
    "/api/metrics",
    "/kubepulse/metrics",
    "/api/kubepulse/metrics",
    "/kube/metrics",
    "/api/kube/metrics",
    "/logs",
    "/api/logs",
    "/kubepulse/logs",
    "/api/kubepulse/logs",
    "/kube/logs",
    "/api/kube/logs",
  ]);

  if (stripIfExact.has(path)) {
    u.pathname = "/";
    u.search = "";
    u.hash = "";
  }

  return u.toString().replace(/\/+$/, "");
}

function kubectlLogs(params: {
  pod: string;
  namespace: string;
  container?: string;
  tail: number;
}) {
  const args = [
    "logs",
    params.pod,
    "-n",
    params.namespace,
    "--tail",
    String(params.tail),
    "--timestamps=true",
  ];

  if (params.container) {
    args.push("-c", params.container);
  }

  return execFileSync("kubectl", args, {
    encoding: "utf8",
    timeout: 8000,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

const CANDIDATE_PATHS = [
  "/kubepulse/logs",
  "/api/kubepulse/logs",
  "/api/logs",
  "/logs",
  "/kube/logs",
  "/api/kube/logs",
];

export async function GET(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = rateLimit({ key: `logs:${ip}`, limit: 120, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", resetAt: rl.resetAt },
      { status: 429 },
    );
  }

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    endpoint: url.searchParams.get("endpoint") || undefined,
    ngrok_url: url.searchParams.get("ngrok_url") || undefined,
    pod: url.searchParams.get("pod") || undefined,
    namespace: url.searchParams.get("namespace") || undefined,
    container: url.searchParams.get("container") || undefined,
    search: url.searchParams.get("search") || undefined,
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    limit: url.searchParams.get("limit") || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let upstreamBase = "";

  if (parsed.data.ngrok_url) {
    upstreamBase = normalizeNgrokBase(parsed.data.ngrok_url);
  } else if (parsed.data.endpoint) {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const { data: endpoint, error } = await supabase
      .from("endpoints")
      .select("id,ngrok_url")
      .eq("id", parsed.data.endpoint)
      .single();
    if (error || !endpoint) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const ngrokParsed = NgrokUrlSchema.safeParse(endpoint.ngrok_url);
    if (!ngrokParsed.success) {
      return NextResponse.json({ error: "invalid_upstream" }, { status: 500 });
    }
    upstreamBase = normalizeNgrokBase(ngrokParsed.data);
  }

  const ns = parsed.data.namespace ?? "default";

  if (parsed.data.endpoint) {
    const queried = await queryLogs({
      endpoint_id: parsed.data.endpoint,
      namespace: parsed.data.namespace,
      pod: parsed.data.pod,
      container: parsed.data.container,
      search: parsed.data.search,
      from: parsed.data.from,
      to: parsed.data.to,
      limit: parsed.data.limit,
    });

    // Query mode returns structured logs while preserving existing UI behavior.
    if (parsed.data.search || parsed.data.from || parsed.data.to || parsed.data.container) {
      return NextResponse.json({ ok: true, ...queried });
    }

    if (queried.logs.length) {
      const stitched = queried.logs
        .map((row) => `[${row.timestamp}] ${row.message}`)
        .join("\n");
      if (stitched.trim().length) {
        return NextResponse.json({ ok: true, logs: stitched });
      }
    }
  }

  const qs = new URLSearchParams({
    pod: parsed.data.pod ?? "",
    namespace: ns,
  });

  if (!parsed.data.pod) {
    return NextResponse.json({ error: "invalid_request", details: "pod is required" }, { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const errors: string[] = [];
    for (const path of CANDIDATE_PATHS) {
      const upstream = joinUrl(upstreamBase, path);
      const upstreamUrl = `${upstream}?${qs.toString()}`;
      try {
        const res = await fetch(upstreamUrl, {
          method: "GET",
          headers: { accept: "text/plain, application/json" },
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`Upstream ${res.status}`);
        const contentType = res.headers.get("content-type") || "";
        const text = contentType.includes("application/json")
          ? JSON.stringify(await res.json(), null, 2)
          : await res.text();

        if (parsed.data.endpoint) {
          const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-200);
          if (lines.length) {
            await ingestLogs(
              lines.map((line) => ({
                endpoint_id: parsed.data.endpoint,
                labels: {
                  namespace: ns,
                  pod: parsed.data.pod ?? "unknown",
                  container: parsed.data.container ?? "",
                },
                message: line,
                source: "pod",
                level: /error|fatal|panic/i.test(line) ? "error" : /warn/i.test(line) ? "warn" : "info",
              })),
            );

            await publishObservabilityEvent({
              endpoint_id: parsed.data.endpoint,
              event_type: "log",
              related_resource: parsed.data.pod,
              related_kind: "pod",
              severity: "info",
              title: `Fetched logs for ${parsed.data.pod ?? "pod"}`,
              details: { namespace: ns, lines: lines.length },
            });
          }
        }

        return NextResponse.json({ ok: true, logs: text });
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    // Fallback path: if ngrok endpoint does not expose logs, read directly via kubectl.
    try {
      const tail = Math.min(1000, Math.max(1, parsed.data.limit ?? 500));
      const text = kubectlLogs({
        pod: parsed.data.pod,
        namespace: ns,
        container: parsed.data.container,
        tail,
      });

      const clean = (text || "").trim();
      if (clean.length) {
        if (parsed.data.endpoint) {
          const lines = clean
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(-200);

          if (lines.length) {
            await ingestLogs(
              lines.map((line) => ({
                endpoint_id: parsed.data.endpoint,
                labels: {
                  namespace: ns,
                  pod: parsed.data.pod ?? "unknown",
                  container: parsed.data.container ?? "",
                },
                message: line,
                source: "pod",
                level: /error|fatal|panic/i.test(line)
                  ? "error"
                  : /warn/i.test(line)
                    ? "warn"
                    : "info",
              })),
            );
          }
        }

        return NextResponse.json({ ok: true, logs: clean, source: "kubectl_fallback" });
      }
      errors.push("kubectl returned empty output");
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }

    return NextResponse.json(
      { error: "upstream_unavailable", details: errors.slice(-3) },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

