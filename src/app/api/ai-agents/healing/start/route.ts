import { NextResponse } from "next/server";
import { healingRunnerService } from "@/lib/healing/agent-runner";
import type { HealingScenario } from "@/lib/healing/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    scenario?: HealingScenario;
    dryRun?: boolean;
    metricsUrl?: string;
  };

  const status = healingRunnerService.startHealing({
    scenario: body.scenario || "pod-crash",
    dryRun: typeof body.dryRun === "boolean" ? body.dryRun : false,
    metricsUrl: body.metricsUrl,
  });

  return NextResponse.json({ ok: true, status });
}
