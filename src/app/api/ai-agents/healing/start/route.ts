import { NextResponse } from "next/server";
import { triggerSelfHeal } from "@/ai-agents/agentController";
import type { HealingScenario, HealingTargetKind } from "@/lib/healing/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const sourceHeader = request.headers.get("x-healing-source");
  if (sourceHeader !== "dashboard-healing-page") {
    return NextResponse.json(
      {
        ok: false,
        error: "healing_start_restricted",
        details: "Healing can only be started from the /dashboard/healing Self Heal button.",
      },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    scenario?: HealingScenario;
    dryRun?: boolean;
    metricsUrl?: string;
    strictLive?: boolean;
    targetName?: string;
    targetNamespace?: string;
    targetKind?: HealingTargetKind;
    remediationPreference?: "restart-workload" | "scale-replicas" | "dependency-first" | "custom-command";
    customCommand?: string;
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
