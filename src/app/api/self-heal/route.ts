import { NextResponse } from "next/server";
import { triggerSelfHeal } from "@/ai-agents/agentController";
import type { HealingScenario } from "@/lib/healing/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    scenario?: HealingScenario;
    dryRun?: boolean;
    metricsUrl?: string;
    strictLive?: boolean;
  };

  const result = await triggerSelfHeal(body);
  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.error,
        details: result.details,
      },
      { status: result.code || 500 },
    );
  }

  return NextResponse.json({ ok: true, status: result.data.status, snapshot: result.data.snapshot });
}
