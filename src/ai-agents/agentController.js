import { runHealingOrchestrator } from "@/ai-agents/healingOrchestrator";

export async function triggerSelfHeal(input = {}) {
  return runHealingOrchestrator({
    scenario: input.scenario,
    dryRun: input.dryRun,
    metricsUrl: input.metricsUrl,
    strictLive: typeof input.strictLive === "boolean" ? input.strictLive : true,
    targetName: input.targetName,
    targetNamespace: input.targetNamespace,
    targetKind: input.targetKind,
  });
}
