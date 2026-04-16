import { getGeminiHealingPlan, getRemediationOptions } from "@/ai-agents/geminiClient";
import { appendFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  checkKubectlAccess,
  getRunnerSnapshot,
  pushRunnerLog,
  startAgentRun,
} from "@/ai-agents/agentService";

function pickLlmStrategy(plan, targetKind) {
  const assessments = Array.isArray(plan?.assessments) ? plan.assessments : [];
  const planning = assessments.find((a) => String(a?.task || "").toLowerCase() === "planning") || assessments[0];
  const decision = String(planning?.decision || "").toLowerCase();
  const reason = String(planning?.reason || "");

  const signalText = `${decision} ${reason} ${(plan?.steps || []).join(" ")}`.toLowerCase();

  if (!signalText.trim()) return null;

  if (signalText.includes("rollback") || signalText.includes("roll back") || signalText.includes("undo")) {
    return {
      type: "rollback",
      reason: reason || "LLM selected rollback",
      confidence: typeof planning?.confidence === "number" ? planning.confidence : undefined,
    };
  }

  if (signalText.includes("scale") || signalText.includes("replica")) {
    const replicasMatch = signalText.match(/(?:to|=)\s*(\d+)\s*replica/);
    const replicas = replicasMatch ? Number(replicasMatch[1]) : undefined;
    return {
      type: "scale_up",
      replicas: Number.isFinite(replicas) && replicas > 0 ? replicas : undefined,
      reason: reason || "LLM selected scaling",
      confidence: typeof planning?.confidence === "number" ? planning.confidence : undefined,
    };
  }

  if (signalText.includes("restart") || signalText.includes("rollout")) {
    return {
      type: targetKind === "deployment" ? "restart_deployment" : "restart_pod",
      reason: reason || "LLM selected restart",
      confidence: typeof planning?.confidence === "number" ? planning.confidence : undefined,
    };
  }

  return null;
}

function pickStrategyFromOption(option, targetKind) {
  if (!option || typeof option !== "object") return null;

  const signalText = `${option.name || ""} ${option.description || ""} ${(option.steps || []).join(" ")}`.toLowerCase();
  if (!signalText.trim()) return null;

  if (signalText.includes("rollback") || signalText.includes("roll back") || signalText.includes("undo")) {
    return { type: "rollback", reason: `SRE selected option: ${option.name || "rollback"}` };
  }

  if (signalText.includes("scale") || signalText.includes("replica")) {
    const replicasMatch = signalText.match(/(?:to|=)\s*(\d+)\s*replica/);
    const replicas = replicasMatch ? Number(replicasMatch[1]) : undefined;
    return {
      type: "scale_up",
      replicas: Number.isFinite(replicas) && replicas > 0 ? replicas : undefined,
      reason: `SRE selected option: ${option.name || "scale"}`,
    };
  }

  if (signalText.includes("restart") || signalText.includes("rollout")) {
    return {
      type: targetKind === "deployment" ? "restart_deployment" : "restart_pod",
      reason: `SRE selected option: ${option.name || "restart"}`,
    };
  }

  return null;
}

function tokenizeCommand(command) {
  const matches = String(command || "").match(/(?:[^\s\"]+|\"[^\"]*\")+/g) || [];
  return matches.map((t) => t.replace(/^\"|\"$/g, ""));
}

function runSelectedOptionSteps(steps, namespace) {
  for (const step of steps) {
    const tokens = tokenizeCommand(step);
    if (!tokens.length) continue;
    if (tokens[0] !== "kubectl") {
      return { ok: false, error: `Unsupported remediation step: ${step}` };
    }

    const args = tokens.slice(1);
    const hasNamespace = args.includes("-n") || args.includes("--namespace") || args.includes("-A") || args.includes("--all-namespaces");
    if (!hasNamespace && namespace) {
      args.push("-n", namespace);
    }

    const run = spawnSync("kubectl", args, { encoding: "utf-8" });
    if (run.status !== 0) {
      return {
        ok: false,
        error: run.stderr || run.stdout || `kubectl step failed (${step})`,
      };
    }
  }

  return { ok: true };
}

async function appendSolutionFixEntry(entry) {
  const filePath = path.resolve(process.cwd(), "solutionfix.md");
  const now = new Date().toISOString();
  const lines = [
    `## ${now} | ${entry.issueId}`,
    `- Scenario: ${entry.scenario}`,
    `- Target: ${entry.targetNamespace || "default"}/${entry.targetName || "auto"} (${entry.targetKind || "pod"})`,
    `- Root cause: ${entry.rootCause || "unknown"}`,
    `- RCA summary: ${entry.rcaSummary || "n/a"}`,
    `- SRE selected option: ${entry.selectedOptionId || "n/a"} (${entry.selectedOptionName || "n/a"})`,
    `- Selection reason: ${entry.selectionReason || "n/a"}`,
    `- Applied strategy: ${entry.strategyType || "n/a"}`,
    `- Strategy reason: ${entry.strategyReason || "n/a"}`,
    "",
  ];

  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

export async function runHealingOrchestrator(input) {
  const scenario = input.scenario || "pod-crash";
  const dryRun = typeof input.dryRun === "boolean" ? input.dryRun : false;
  const metricsUrl = (input.metricsUrl || process.env.METRICS_URL || "").trim();
  const strictLive = typeof input.strictLive === "boolean" ? input.strictLive : true;
  const targetName = (input.targetName || "").trim();
  const targetNamespace = (input.targetNamespace || "default").trim() || "default";
  const targetKind = input.targetKind || "pod";
  const selectedOption = (input.selectedOption || "").trim();
  const selectionReason = (input.selectionReason || "").trim();
  const selectedOptionStepsInput = Array.isArray(input.selectedOptionSteps) ? input.selectedOptionSteps : [];
  const providedDecisionOptions = Array.isArray(input.decisionOptions) ? input.decisionOptions : [];
  const selectedOptionObject =
    providedDecisionOptions.find((opt) => String(opt?.id || "") === selectedOption) || providedDecisionOptions[0] || null;
  const selectedOptionSteps = selectedOptionStepsInput.length
    ? selectedOptionStepsInput.map((s) => String(s || "").trim()).filter(Boolean)
    : Array.isArray(selectedOptionObject?.steps)
      ? selectedOptionObject.steps.map((s) => String(s || "").trim()).filter(Boolean)
      : [];

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

  const plan = await getGeminiHealingPlan({ scenario, dryRun, metricsUrl, targetName, targetNamespace, targetKind });
  const providedSelected = selectedOptionObject;
  const optionStrategy = pickStrategyFromOption(providedSelected, targetKind);
  const llmStrategy = optionStrategy || pickLlmStrategy(plan, targetKind);
  const selectedStepsExecuted = !dryRun && selectedOptionSteps.length > 0;

  if (selectedStepsExecuted) {
    const stepExec = runSelectedOptionSteps(selectedOptionSteps, targetNamespace);
    if (!stepExec.ok) {
      return {
        ok: false,
        code: 500,
        error: "selected_option_execution_failed",
        details: stepExec.error,
      };
    }
  }

  const started = startAgentRun({
    scenario,
    dryRun: selectedStepsExecuted ? true : dryRun,
    metricsUrl: metricsUrl || undefined,
    strictLive,
    targetName: targetName || undefined,
    targetNamespace: targetName ? targetNamespace : undefined,
    targetKind: targetName ? targetKind : undefined,
    llmStrategyType: llmStrategy?.type,
    llmStrategyReplicas: llmStrategy?.replicas,
    llmStrategyReason: llmStrategy?.reason,
    llmOptionSteps: selectedOptionSteps,
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

    pushRunnerLog({
      issue_id: started.activeIssueId,
      agent_name: "GeminiKnowledgeBase",
      event_type: "ANALYZING",
      description: targetName ? `${plan.summary} Target: ${targetNamespace}/${targetName}.` : plan.summary,
      action_taken: llmStrategy
        ? `Plan steps: ${(plan.steps || []).join(" | ") || "n/a"} | Strategy=${llmStrategy.type}`
        : `Plan steps: ${(plan.steps || []).join(" | ") || "n/a"}`,
      status: "IN_PROGRESS",
      confidence: typeof plan.confidence === "number" ? plan.confidence : undefined,
      reasoning: `source=${plan.source}`,
      raw: { plan, llmStrategy },
    });

    if (selectedStepsExecuted) {
      pushRunnerLog({
        issue_id: started.activeIssueId,
        agent_name: "ExecutionerAgent",
        event_type: "FIXING",
        description: `Executed ${selectedOptionSteps.length} selected remediation command(s) via kubectl before orchestration run.`,
        action_taken: `Selected option: ${selectedOption || "n/a"}`,
        status: "IN_PROGRESS",
      });
    }

    // Use SRE-provided options when available, otherwise generate via LLM.
    const remediationOptions = providedDecisionOptions.length
      ? {
          options: providedDecisionOptions,
          selected_option: selectedOption,
          selection_reason: selectionReason || "Chosen by SRE",
          root_cause: targetName || "unknown-pod",
        }
      : await getRemediationOptions({
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
      } catch (err) {
        console.error("Failed to store decision analysis:", err);
      }

      try {
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

        await appendSolutionFixEntry({
          issueId: started.activeIssueId,
          scenario,
          targetName,
          targetNamespace,
          targetKind,
          rootCause: remediationOptions.root_cause || targetName || "unknown",
          rcaSummary: plan.summary,
          selectedOptionId: remediationOptions.selected_option,
          selectedOptionName:
            remediationOptions.options.find((opt) => opt.id === remediationOptions.selected_option)?.name || "unknown",
          selectionReason: remediationOptions.selection_reason,
          strategyType: llmStrategy?.type,
          strategyReason: llmStrategy?.reason,
        });
      } catch (err) {
        console.error("Failed to append solution fix:", err);
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
