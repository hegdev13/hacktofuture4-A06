import { getGeminiHealingPlan, getRemediationOptions } from "@/ai-agents/geminiClient";
import {
  checkKubectlAccess,
  getRunnerSnapshot,
  pushRunnerLog,
  startAgentRun,
} from "@/ai-agents/agentService";

export async function runHealingOrchestrator(input) {
  const scenario = input.scenario || "pod-crash";
  const dryRun = typeof input.dryRun === "boolean" ? input.dryRun : false;
  const metricsUrl = (input.metricsUrl || process.env.METRICS_URL || "").trim();
  const strictLive = typeof input.strictLive === "boolean" ? input.strictLive : true;
  const targetName = (input.targetName || "").trim();
  const targetNamespace = (input.targetNamespace || "default").trim() || "default";
  const targetKind = input.targetKind || "pod";
  const remediationPreference = input.remediationPreference;
  const customCommand = (input.customCommand || "").trim();

  const kubectl = checkKubectlAccess();
  if (!kubectl.ok) {
    return {
      ok: false,
      code: 503,
      error: "kubectl_unavailable",
      details: kubectl.stderr || kubectl.stdout || "kubectl not accessible from app host",
    };
  }

  if (strictLive && !metricsUrl) {
    return {
      ok: false,
      code: 400,
      error: "metrics_url_required",
      details: "Set an ngrok metrics URL before starting live healing.",
    };
  }

  const started = startAgentRun({
    scenario,
    dryRun,
    metricsUrl: metricsUrl || undefined,
    strictLive,
    targetName: targetName || undefined,
    targetNamespace: targetName ? targetNamespace : undefined,
    targetKind: targetName ? targetKind : undefined,
    remediationPreference,
    customCommand: customCommand || undefined,
  });

  if (started.activeIssueId) {
    const targetLabel = targetName ? `${targetNamespace}/${targetName} (${targetKind})` : "auto-detected workload";
    pushRunnerLog({
      issue_id: started.activeIssueId,
      agent_name: "Orchestrator",
      event_type: "ANALYZING",
      description: `Self-heal trigger accepted (scenario=${scenario}, dryRun=${dryRun ? "true" : "false"}, target=${targetLabel}).`,
      action_taken: targetName ? `Prioritizing ${targetLabel}` : "Trigger received",
      status: "IN_PROGRESS",
    });

    const plan = await getGeminiHealingPlan({ scenario, dryRun, metricsUrl, targetName, targetNamespace, targetKind });
    pushRunnerLog({
      issue_id: started.activeIssueId,
      agent_name: "GeminiKnowledgeBase",
      event_type: "ANALYZING",
      description: targetName ? `${plan.summary} Target: ${targetNamespace}/${targetName}.` : plan.summary,
      action_taken: `Plan steps: ${(plan.steps || []).join(" | ") || "n/a"}`,
      status: "IN_PROGRESS",
      confidence: typeof plan.confidence === "number" ? plan.confidence : undefined,
      reasoning: `source=${plan.source}`,
      raw: { plan },
    });

    // Generate multiple remediation options for decision analysis
    const remediationOptions = await getRemediationOptions({
      scenario,
      rootCause: targetName || "unknown-pod",
      failureChain: [],
      affectedCount: 0,
    });

    // Store decision analysis
    if (remediationOptions.options && remediationOptions.options.length > 0) {
      try {
        await fetch(process.env.NEXT_PUBLIC_APP_URL ? `${process.env.NEXT_PUBLIC_APP_URL}/api/healing/decision-analysis` : "/api/healing/decision-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            issue_id: started.activeIssueId,
            root_cause: remediationOptions.root_cause || targetName || "unknown",
            options: remediationOptions.options,
            selected_option: remediationOptions.selected_option,
            selection_reason: remediationOptions.selection_reason,
            affected_resources_count: 0,
          }),
        });

        pushRunnerLog({
          issue_id: started.activeIssueId,
          agent_name: "DecisionAnalyzer",
          event_type: "REMEDIATION_OPTIONS",
          description: `Generated ${remediationOptions.options.length} remediation options`,
          action_taken: `Selected: ${remediationOptions.selected_option}. Reason: ${remediationOptions.selection_reason}`,
          status: "IN_PROGRESS",
          confidence: remediationOptions.options.find((opt) => opt.id === remediationOptions.selected_option)?.confidence || 0.5,
          raw: { options: remediationOptions },
        });
      } catch (err) {
        console.error("Failed to store decision analysis:", err);
      }
    }
  }

  return {
    ok: true,
    code: 200,
    data: {
      status: started,
      snapshot: getRunnerSnapshot().status,
    },
  };
}
