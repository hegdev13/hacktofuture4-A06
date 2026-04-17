import { NextResponse } from "next/server";
import { triggerSelfHeal } from "@/ai-agents/agentController";
import type { HealingScenario } from "@/lib/healing/types";
import { getRemediationOptions } from "@/ai-agents/geminiClient";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    preview?: boolean;
    scenario?: HealingScenario;
    dryRun?: boolean;
    metricsUrl?: string;
    strictLive?: boolean;
    targetName?: string;
    targetNamespace?: string;
    targetKind?: "pod" | "deployment";
    rootCause?: string;
    failureChain?: string[];
    affectedCount?: number;
    selectedOption?: string;
    selectionReason?: string;
    selectedOptionSteps?: string[];
    decisionOptions?: Array<{
      id?: string;
      name?: string;
      description?: string;
      steps?: string[];
      cost?: Record<string, unknown>;
      pros?: string[];
      cons?: string[];
      confidence?: number;
    }>;
  };

  if (body.preview) {
    const options = await getRemediationOptions({
      scenario: body.scenario || "pod-crash",
      rootCause: body.rootCause || body.targetName || "unknown-workload",
      failureChain: Array.isArray(body.failureChain) ? body.failureChain : [],
      affectedCount: Number(body.affectedCount || 0),
      targetName: body.targetName,
      targetNamespace: body.targetNamespace || "default",
      targetKind: body.targetKind || "pod",
    });

    return NextResponse.json({ ok: true, decision: options });
  }

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
