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
  cost: {
    resolution: string;
    downtime: string;
    resourceImpact: string;
    analysisUsd: number;
  };
};

type RemediationOptionsMeta = {
  source?: string;
  reason?: string;
  usageMetadata?: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
  };
};

function mapExecutionStrategy(name: string, description: string): DashboardOption["executionStrategy"] {
  const signal = `${name} ${description}`.toLowerCase();
  if (signal.includes("scale") || signal.includes("replica")) return "scale-replicas";
  if (signal.includes("dependency") || signal.includes("upstream") || signal.includes("cascade")) return "dependency-first";
  return "restart-workload";
}

function mapResolutionCost(risk: string) {
  const normalized = String(risk || "").toLowerCase();
  if (normalized === "low") return "Low";
  if (normalized === "high") return "High";
  return "Moderate";
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

    const optionsMeta = optionsResult as RemediationOptionsMeta;
    const source = optionsResult.source === "gemini" ? "gemini" : "fallback";
    const fallbackReason = optionsMeta.reason;

    // Show API-key warning only when key is genuinely missing.
    if (source === "fallback" && fallbackReason === "no_api_key") {
      return NextResponse.json({
        ok: true,
        options: [],
        source: "none",
        message: "No Gemini API key configured. Healing options are not available.",
      });
    }

    // Gemini runtime/format failures should not be presented as "missing key".
    if (source === "fallback") {
      const fallbackMessage =
        fallbackReason === "quota_exceeded"
          ? "Gemini quota exceeded for this API key. Check rate limits or billing, then retry."
          : fallbackReason === "model_unavailable"
            ? "All configured Gemini models are unavailable for this key. Set GEMINI_FALLBACK_MODELS (comma-separated) or update GEMINI_MODEL, then retry."
            : "Gemini request failed or returned invalid output. Please retry.";

      return NextResponse.json({
        ok: true,
        options: [],
        source: "error",
        message: fallbackMessage,
      });
    }

    const rawOptions = Array.isArray(optionsResult.options) ? optionsResult.options.slice(0, 3) : [];

    const normalized: DashboardOption[] = rawOptions.map((option, index) => {
      const confidence = Number(option.confidence || 0.5);
      const score = Math.max(0, Math.min(100, Math.round(confidence * 100)));
      const analysisUsd = Number(option.cost?.llm_analysis_usd || optionsMeta.usageMetadata?.cost || 0);

      return {
        id: String(option.id || `option-${index + 1}`),
        title: String(option.name || `Option ${index + 1}`),
        summary: String(option.description || "No summary provided."),
        advantage: Array.isArray(option.pros) ? option.pros.map((p) => String(p)) : [],
        tradeoff: Array.isArray(option.cons) ? option.cons.map((c) => String(c)) : [],
        score,
        estimatedCost: `${String(option.cost?.execution_time || "unknown")} execution`,
        executionStrategy: mapExecutionStrategy(String(option.name || ""), String(option.description || "")),
        source,
        cost: {
          resolution: mapResolutionCost(String(option.cost?.risk_level || "medium")),
          downtime: String(option.cost?.downtime || "unknown"),
          resourceImpact: String(option.cost?.resource_impact || "unknown"),
          analysisUsd,
        },
      };
    });

    normalized.sort((a, b) => b.score - a.score);

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
