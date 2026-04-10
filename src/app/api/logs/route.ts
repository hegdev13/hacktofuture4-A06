import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NgrokUrlSchema } from "@/lib/validation";
import { rateLimit } from "@/lib/security/rate-limit";

const QuerySchema = z.object({
  endpoint: z.string().uuid(),
  pod: z.string().min(1),
  namespace: z.string().min(1).optional(),
});

function joinUrl(base: string, path: string) {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
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
    endpoint: url.searchParams.get("endpoint"),
    pod: url.searchParams.get("pod"),
    namespace: url.searchParams.get("namespace") || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

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

  const ns = parsed.data.namespace ?? "default";
  const qs = new URLSearchParams({ pod: parsed.data.pod, namespace: ns });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const errors: string[] = [];
    for (const path of CANDIDATE_PATHS) {
      const upstream = joinUrl(ngrokParsed.data, path);
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

        return NextResponse.json({ ok: true, logs: text });
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    return NextResponse.json(
      { error: "upstream_unavailable", details: errors.slice(-3) },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

