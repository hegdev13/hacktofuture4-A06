import { NextResponse } from "next/server";
import { fetchClusterSnapshot } from "@/lib/kube/fetch-metrics";
import { NgrokUrlSchema } from "@/lib/validation";
import { rateLimit } from "@/lib/security/rate-limit";

export async function GET(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = rateLimit({ key: `dashpods:${ip}`, limit: 120, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", resetAt: rl.resetAt },
      { status: 429 },
    );
  }

  const url = new URL(request.url);
  const ngrokRaw = url.searchParams.get("ngrok_url");
  const parsed = NgrokUrlSchema.safeParse(ngrokRaw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_ngrok_url" }, { status: 400 });
  }

  try {
    const snapshot = await fetchClusterSnapshot(parsed.data);
    return NextResponse.json({ ok: true, ...snapshot });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
