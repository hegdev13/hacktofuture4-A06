import { NextResponse } from "next/server";
import { getRemediationOptions } from "@/ai-agents/geminiClient";
import type { HealingScenario, HealingTargetKind } from "@/lib/healing/types";

export const runtime = "nodejs";

type DashboardOption = {
  id: string;
  title: string;
  summary: string;
  advantage: string[];
  tradeoff: string[];
  score: number;
  estimatedCost: string;
  executionStrategy: "restart-workload" | "scale-replicas" | "dependency-first";
  source: "gemini" | "fallback";
};

function inferExecutionStrategy(text: string): DashboardOption["executionStrategy"] {
  const t = text.toLowerCase();
  if (t.includes("scale") || t.includes("replica")) return "scale-replicas";
  if (t.includes("depend") || t.includes("upstream") || t.includes("cascade")) return "dependency-first";
  return "restart-workload";
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const scenario = (url.searchParams.get("scenario") || "pod-crash") as HealingScenario;
    const targetName = (url.searchParams.get("targetName") || "selected-workload").trim();
    const targetKind = ((url.searchParams.get("targetKind") || "pod").trim().toLowerCase() === "deployment"
      ? "deployment"
      : "pod") as HealingTargetKind;

    const optionsResult = await getRemediationOptions({
      scenario,
      rootCause: targetName,
      failureChain: [],
      affectedCount: 1,
      targetKind,
    });

    const selected = String(optionsResult.selected_option || "").trim();
    const normalized: DashboardOption[] = (Array.isArray(optionsResult.options) ? optionsResult.options : [])
      .slice(0, 3)
      .map((opt, idx) => {
        const summary = String(opt.description || "").trim();
        const title = String(opt.name || `Option ${idx + 1}`).trim();
        const blendedText = `${title} ${summary} ${(opt.steps || []).join(" ")}`;
        const baseScore = Math.max(0, Math.min(100, Math.round(Number(opt.confidence || 0.5) * 100)));
        const score = String(opt.id || "") === selected ? Math.min(100, baseScore + 5) : baseScore;

        return {
          id: `llm-option-${idx + 1}`,
          title,
          summary,
          advantage: Array.isArray(opt.pros) && opt.pros.length ? opt.pros.map((p) => String(p)) : ["Recommended by Gemini"],
          tradeoff: Array.isArray(opt.cons) && opt.cons.length ? opt.cons.map((c) => String(c)) : ["Requires verification after execution"],
          score,
          estimatedCost: `${String(opt.cost?.resource_impact || "Unknown")} impact, ${String(opt.cost?.execution_time || "unknown time")}`,
          executionStrategy: inferExecutionStrategy(blendedText),
          source: optionsResult.source === "gemini" ? "gemini" : "fallback",
        };
      })
      .sort((a, b) => b.score - a.score);

    return NextResponse.json({
      ok: true,
      options: normalized,
      source: optionsResult.source || "fallback",
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
