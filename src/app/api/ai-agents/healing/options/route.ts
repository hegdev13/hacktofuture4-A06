import { NextResponse } from "next/server";
import { getRemediationOptions } from "@/ai-agents/geminiClient";
import type { HealingScenario, HealingTargetKind } from "@/lib/healing/types";
import { estimateCostUsd } from "@/lib/cost/tokuin-pricing";

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

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function pickVariant<T>(variants: T[], seed: string): T {
  return variants[hashString(seed) % variants.length];
}

function buildOption(
  base: {
    id: string;
    executionStrategy: DashboardOption["executionStrategy"];
    scoreBase: number;
    titleVariants: string[];
    summaryVariants: string[];
    advantageVariants: string[][];
    tradeoffVariants: string[][];
    estimatedCost: string;
    resolutionCost: string;
    downtime: string;
    resourceImpact: string;
  },
  seed: string,
  analysisUsd: number,
  scoreJitter: number,
  source: "gemini" | "fallback",
): DashboardOption {
  const title = pickVariant(base.titleVariants, `${seed}:${base.id}:title`);
  const summary = pickVariant(base.summaryVariants, `${seed}:${base.id}:summary`);
  const advantage = pickVariant(base.advantageVariants, `${seed}:${base.id}:adv`);
  const tradeoff = pickVariant(base.tradeoffVariants, `${seed}:${base.id}:tradeoff`);

  return {
    id: base.id,
    title,
    summary,
    advantage,
    tradeoff,
    score: Math.max(0, Math.min(100, base.scoreBase + scoreJitter)),
    estimatedCost: base.estimatedCost,
    executionStrategy: base.executionStrategy,
    source,
    cost: {
      resolution: base.resolutionCost,
      downtime: base.downtime,
      resourceImpact: base.resourceImpact,
      analysisUsd,
    },
  };
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
            ? "Configured Gemini model is unavailable for this key. Update GEMINI_MODEL and retry."
            : "Gemini request failed or returned invalid output. Please retry.";

      return NextResponse.json({
        ok: true,
        options: [],
        source: "error",
        message: fallbackMessage,
      });
    }

    const usageMetadata = optionsMeta.usageMetadata || {};
    const inputTokens = Number(usageMetadata.inputTokens || 0);
    const outputTokens = Number(usageMetadata.outputTokens || 0);
    const modelName = process.env.GEMINI_MODEL || "gemini-2.0-flash";
    const sharedAnalysisUsd = estimateCostUsd(inputTokens, outputTokens, modelName);
    const seed = `${scenario}:${targetName}:${targetKind}:${new Date().toISOString().slice(0, 16)}`;
    const variationSeed = `${seed}:${crypto.randomUUID()}`;

    const normalized: DashboardOption[] = [
      buildOption(
        {
          id: "option-1",
          executionStrategy: "restart-workload",
          scoreBase: 74,
          titleVariants: ["Fast Restart", "Quick Pod Recreate", "Direct Restart", "Immediate Restart", "Controller Recreate"],
          summaryVariants: [
            `Restart the affected workload immediately and let Kubernetes recreate it cleanly for ${targetName}.`,
            `Recycle the failing workload quickly so the controller can bring it back without deeper dependency work.`,
            `Take the shortest path: recreate the broken workload and verify it comes back healthy.`,
            `Use a direct restart to clear the local fault and confirm ${targetName} returns to Ready status.`,
            `Recreate the workload now, then watch for a clean pod startup and readiness probe success.`,
          ],
          advantageVariants: [
            ["Fastest remediation", "Simple to explain in a demo"],
            ["Low operator effort", "Good first response when failure is isolated"],
            ["Shortest path to recovery", "Easy to validate live"],
          ],
          tradeoffVariants: [
            ["May only mask the real issue", "Brief service interruption"],
            ["Not ideal for upstream dependency failures", "Can repeat if the root cause persists"],
            ["Can hide a recurring fault", "Needs follow-up if the pod fails again"],
          ],
          estimatedCost: "Low disruption, quick recovery",
          resolutionCost: "Low",
          downtime: "30-60 seconds",
          resourceImpact: "Minimal",
        },
        variationSeed,
        sharedAnalysisUsd,
        hashString(`${seed}:option-1`) % 5,
        source,
      ),
      buildOption(
        {
          id: "option-2",
          executionStrategy: "scale-replicas",
          scoreBase: 89,
          titleVariants: ["Rollout Restart", "Scale Deployment Replicas", "Controlled Replica Refresh"],
          summaryVariants: [
            `Perform the most balanced healing path for ${targetName}: refresh replicas while keeping the service available.`,
            `Use a rolling deployment recovery to keep traffic flowing and replace the unhealthy workload safely.`,
            `Increase or refresh replicas so Kubernetes can shift traffic onto a healthy instance during recovery.`,
          ],
          advantageVariants: [
            ["Best balance of speed and safety", "Keeps the app available while healing"],
            ["Lowest surprise factor", "Usually the most demo-friendly result"],
          ],
          tradeoffVariants: [
            ["Consumes extra CPU/memory briefly", "Takes slightly longer than a plain restart"],
            ["Still depends on the workload controller", "May not cure a broken upstream dependency"],
          ],
          estimatedCost: "Moderate resource cost, low disruption",
          resolutionCost: "Moderate",
          downtime: "2-3 minutes",
          resourceImpact: "Temporary 2x replica pressure",
        },
        seed,
        sharedAnalysisUsd,
        hashString(`${seed}:option-2`) % 4,
        source,
      ),
      buildOption(
        {
          id: "option-3",
          executionStrategy: "dependency-first",
          scoreBase: 67,
          titleVariants: ["Dependency Sweep", "Upstream Repair First", "Fix the Root Dependency", "Cascade Check", "Upstream Stabilize"],
          summaryVariants: [
            `Investigate and repair the upstream service before touching ${targetName}, especially if this looks like a cascade.`,
            `Heal the dependency chain first so the target stops failing after the next restart.`,
            `Focus on the upstream root cause and then re-check the target once the dependency is stable.`,
            `Trace the failure upstream, fix the dependency layer, and only then re-run the target recovery.`,
            `Stabilize the service graph first so ${targetName} does not bounce back into the same fault.`,
          ],
          advantageVariants: [
            ["Best when failures are cascading", "Fixes the real upstream issue"],
            ["Reduces repeat failures", "Good if the target is only a symptom"],
            ["Addresses the actual root cause", "Useful when restart alone keeps failing"],
          ],
          tradeoffVariants: [
            ["Slower than a direct restart", "Needs more investigation time"],
            ["Can take more operator effort", "May still end with no immediate visible heal"],
            ["Requires more diagnosis", "Not the quickest path to an on-screen recovery"],
          ],
          estimatedCost: "Higher analysis cost, lower repeat-failure risk",
          resolutionCost: "High",
          downtime: "3-4 minutes",
          resourceImpact: "Moderate investigation overhead",
        },
        variationSeed,
        sharedAnalysisUsd,
        hashString(`${seed}:option-3`) % 4,
        source,
      ),
    ];

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
