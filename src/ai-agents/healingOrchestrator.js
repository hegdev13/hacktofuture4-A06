import { getGeminiHealingPlan, getRemediationOptions } from "@/ai-agents/geminiClient";
import { appendFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  checkKubectlAccess,
  getRunnerSnapshot,
  pushRunnerLog,
  startAgentRun,
  getAgentStatus,
  setAwaitingSREValidation,
  sreAcceptExecution,
  sreRejectExecution,
} from "@/ai-agents/agentService";

// In-memory store for pending SRE decisions
const pendingDecisions = new Map();

// In-memory store for pending SRE validations (after execution)
const pendingValidations = new Map();

// Import executor agent for rollback
let executorAgent = null;
try {
  const { default: executor } = await import("@/ai-agents/self-healing-system/agents/executor.js");
  executorAgent = executor;
} catch {
  // Will try dynamic import later
}

/**
 * Get pending SRE decision for an issue
 */
export function getPendingDecision(issueId) {
  return pendingDecisions.get(issueId);
}

/**
 * Get all pending SRE decisions
 */
export function getAllPendingDecisions() {
  return Array.from(pendingDecisions.entries()).map(([issueId, data]) => ({
    issueId,
    ...data,
  }));
}

/**
 * Clear a pending decision
 */
export function clearPendingDecision(issueId) {
  pendingDecisions.delete(issueId);
}

/**
 * Submit SRE decision and resume execution
 */
export async function submitSREDecision(issueId, selectedOptionId, selectionReason, sreUser = "sre") {
  const pending = pendingDecisions.get(issueId);
  if (!pending) {
    return { ok: false, error: "No pending decision found for issue" };
  }

  const { input, plan, remediationOptions } = pending;

  // Find selected option
  const selectedOption = remediationOptions.options?.find((opt) => opt.id === selectedOptionId);
  if (!selectedOption) {
    return { ok: false, error: "Selected option not found" };
  }

  // Clear pending state
  clearPendingDecision(issueId);

  // Log SRE decision
  pushRunnerLog({
    issue_id: issueId,
    agent_name: "SRE",
    event_type: "DECISION",
    description: `SRE (${sreUser}) selected option: ${selectedOption.name}`,
    action_taken: `Selected ${selectedOptionId}: ${selectionReason}`,
    status: "IN_PROGRESS",
    confidence: selectedOption.confidence,
    reasoning: selectionReason,
    raw: { selectedOption, allOptions: remediationOptions.options },
  });

  // Resume execution with SRE's choice
  return executeWithDecision(issueId, input, plan, {
    ...remediationOptions,
    selected_option: selectedOptionId,
    selection_reason: selectionReason,
    selected_by: sreUser,
  }, selectedOption);
}

/**
 * Get pending SRE validation for an issue (after execution)
 */
export function getPendingValidation(issueId) {
  return pendingValidations.get(issueId);
}

/**
 * Get all pending SRE validations
 */
export function getAllPendingValidations() {
  return Array.from(pendingValidations.entries()).map(([issueId, data]) => ({
    issueId,
    ...data,
  }));
}

/**
 * 🔹 Step 5a: SRE accepts execution results
 */
export async function submitSREAcceptance(issueId, reason, sreUser = "sre") {
  const pending = pendingValidations.get(issueId);
  if (!pending) {
    return { ok: false, error: "No pending validation found for issue" };
  }

  // Clear checkpoint
  if (executorAgent) {
    executorAgent.getCheckpointManager().clearCheckpoint(issueId);
  }

  // Clear pending validation
  pendingValidations.delete(issueId);

  // Log acceptance
  pushRunnerLog({
    issue_id: issueId,
    agent_name: "SRE",
    event_type: "DECISION",
    description: `SRE (${sreUser}) ACCEPTED the execution results`,
    action_taken: reason || "Fix accepted",
    status: "SUCCESS",
  });

  // Update agent runner state
  sreAcceptExecution(issueId, reason);

  return {
    ok: true,
    code: 200,
    data: {
      message: "Fix accepted and finalized",
      issueId,
      action: "accepted",
    },
  };
}

/**
 * 🔹 Step 5b: SRE rejects execution - rollback
 */
export async function submitSRERejection(issueId, reason, sreUser = "sre") {
  const pending = pendingValidations.get(issueId);
  if (!pending) {
    return { ok: false, error: "No pending validation found for issue" };
  }

  // Execute rollback using executor agent
  let rollbackResult = { ok: false, message: "Executor not available" };

  if (executorAgent) {
    rollbackResult = await executorAgent.rollbackFix(issueId);
  } else {
    // Try dynamic import as fallback
    try {
      const { default: executor } = await import("@/ai-agents/self-healing-system/agents/executor.js");
      rollbackResult = await executor.rollbackFix(issueId);
    } catch (err) {
      rollbackResult = { ok: false, message: `Rollback failed: ${err.message}` };
    }
  }

  // Clear pending validation
  pendingValidations.delete(issueId);

  // Log rejection and rollback
  pushRunnerLog({
    issue_id: issueId,
    agent_name: "SRE",
    event_type: "DECISION",
    description: `SRE (${sreUser}) REJECTED the execution. Rollback ${rollbackResult.ok ? "successful" : "failed"}.`,
    action_taken: reason || "Fix rejected, rollback attempted",
    status: rollbackResult.ok ? "SRE_REJECTED" : "FAILED",
    raw: { rollbackResult },
  });

  // Update agent runner state
  sreRejectExecution(issueId, rollbackResult, reason);

  return {
    ok: rollbackResult.ok,
    code: rollbackResult.ok ? 200 : 500,
    data: {
      message: rollbackResult.ok
        ? "Fix rejected and rollback completed"
        : "Fix rejected but rollback failed",
      issueId,
      action: "rejected",
      rollback: rollbackResult,
    },
  };
}

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

async function executeWithDecision(issueId, input, plan, remediationOptions, selectedOption) {
  const {
    dryRun = false,
    targetName = "",
    targetNamespace = "default",
    targetKind = "pod",
    skipSREValidation = false, // If true, skip SRE validation (for auto-execute)
  } = input;

  // Build option strategy
  const optionStrategy = pickStrategyFromOption(selectedOption, targetKind);
  const llmStrategy = optionStrategy || pickLlmStrategy(plan, targetKind);
  const selectedOptionSteps = Array.isArray(selectedOption?.steps)
    ? selectedOption.steps.map((s) => String(s || "").trim()).filter(Boolean)
    : [];

  // 🔹 Step 1: Pre-checkpoint - Capture state before execution
  let checkpointResult = { ok: false, canRollback: false };
  if (!dryRun && executorAgent) {
    try {
      checkpointResult = await executorAgent.getCheckpointManager().captureCheckpoint(
        issueId,
        targetName || "auto-detected",
        targetNamespace,
        { type: llmStrategy?.type || "unknown", target: targetName, namespace: targetNamespace }
      );

      pushRunnerLog({
        issue_id: issueId,
        agent_name: "ExecutionerAgent",
        event_type: "FIXING",
        description: `[CHECKPOINT] Captured pre-execution state for ${targetNamespace}/${targetName || "target"}`,
        action_taken: checkpointResult.ok ? "Checkpoint created successfully" : "Checkpoint creation failed",
        status: "IN_PROGRESS",
      });
    } catch (err) {
      console.error("[CHECKPOINT] Failed:", err.message);
    }
  }

  // 🔹 Step 2: Execute the SRE-selected steps
  let executionResult = { success: true, message: "No steps to execute" };

  if (selectedOptionSteps.length > 0 && !dryRun) {
    const stepExec = runSelectedOptionSteps(selectedOptionSteps, targetNamespace);

    executionResult = {
      success: stepExec.ok,
      fixType: llmStrategy?.type || "custom_steps",
      target: targetName,
      message: stepExec.ok
        ? `Executed ${selectedOptionSteps.length} SRE-selected command(s)`
        : `Execution failed: ${stepExec.error}`,
    };

    if (!stepExec.ok) {
      return {
        ok: false,
        code: 500,
        error: "selected_option_execution_failed",
        details: stepExec.error,
        checkpoint: checkpointResult.ok,
      };
    }

    pushRunnerLog({
      issue_id: issueId,
      agent_name: "ExecutionerAgent",
      event_type: "FIXING",
      description: `[FIX] Executed ${selectedOptionSteps.length} SRE-selected remediation command(s)`,
      action_taken: `Selected option: ${selectedOption.id} - ${selectedOption.name}`,
      status: "IN_PROGRESS",
      raw: { steps: selectedOptionSteps, checkpoint: checkpointResult.ok },
    });
  }

  // 🔹 Step 3: Monitor/Verification (simulate for now - actual verification happens in executor agent)
  // In a real implementation, the executor agent would call back with verification results
  executionResult.verification = {
    verified: true,
    reason: "Execution completed - awaiting SRE validation",
  };

  // Store decision analysis
  try {
    await fetch(process.env.NEXT_PUBLIC_APP_URL ? `${process.env.NEXT_PUBLIC_APP_URL}/api/healing/decision-analysis` : "/api/healing/decision-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issue_id: issueId,
        root_cause: remediationOptions.root_cause || targetName || "unknown",
        options: remediationOptions.options,
        selected_option: selectedOption.id,
        selection_reason: remediationOptions.selection_reason || "SRE selected",
        selected_by: remediationOptions.selected_by || "sre",
        affected_resources_count: 0,
        checkpoint_captured: checkpointResult.ok,
      }),
    });
  } catch (err) {
    console.error("Failed to store decision analysis:", err);
  }

  // Append to solution fix log
  try {
    await appendSolutionFixEntry({
      issueId,
      scenario: input.scenario || "pod-crash",
      targetName,
      targetNamespace,
      targetKind,
      rootCause: remediationOptions.root_cause || targetName || "unknown",
      rcaSummary: plan.summary,
      selectedOptionId: selectedOption.id,
      selectedOptionName: selectedOption.name || "unknown",
      selectionReason: remediationOptions.selection_reason || "SRE selected",
      strategyType: llmStrategy?.type,
      strategyReason: llmStrategy?.reason,
      checkpointCaptured: checkpointResult.ok,
    });
  } catch (err) {
    console.error("Failed to append solution fix:", err);
  }

  // 🔹 Step 4: Human validation (SRE) - If not skipping validation
  if (!dryRun && !skipSREValidation) {
    // Store pending validation state
    const pendingValidation = {
      input,
      plan,
      remediationOptions,
      selectedOption,
      executionResult,
      checkpointAvailable: checkpointResult.ok,
      createdAt: new Date().toISOString(),
      status: "awaiting_sre_validation",
    };
    pendingValidations.set(issueId, pendingValidation);

    // Set state to awaiting SRE validation
    setAwaitingSREValidation(issueId, executionResult, checkpointResult.ok);

    pushRunnerLog({
      issue_id: issueId,
      agent_name: "Orchestrator",
      event_type: "DECISION",
      description: `[SRE_VALIDATION] Execution complete. Awaiting SRE validation.`,
      action_taken: checkpointResult.ok
        ? "SRE can ACCEPT (finalize) or REJECT (rollback)"
        : "SRE review required - no checkpoint for rollback",
      status: "AWAITING_SRE_VALIDATION",
      raw: { executionResult, checkpoint: checkpointResult.ok },
    });

    return {
      ok: true,
      code: 200,
      awaitingSREValidation: true,
      data: {
        issueId,
        status: {
          state: "awaiting_sre_validation",
          totalLogs: getRunnerSnapshot().logs?.length || 0,
          activeAgent: "SRE",
          activeAction: "Awaiting SRE validation of execution results",
          activeIssueId: issueId,
        },
        executionResult,
        checkpointAvailable: checkpointResult.ok,
        message: "Execution complete. Awaiting SRE validation.",
        sreActions: checkpointResult.ok
          ? { accept: `/api/healing/sre-validation/${issueId}/accept`, reject: `/api/healing/sre-validation/${issueId}/reject` }
          : { accept: `/api/healing/sre-validation/${issueId}/accept` },
      },
    };
  }

  // 🔹 Step 5a: If skipping validation or dry run, accept automatically
  if (skipSREValidation || dryRun) {
    pushRunnerLog({
      issue_id: issueId,
      agent_name: "Orchestrator",
      event_type: "RESOLVED",
      description: skipSREValidation
        ? "Execution completed (SRE validation skipped)"
        : "Dry run completed - no changes applied",
      action_taken: skipSREValidation ? "Auto-accepted (auto-execute mode)" : "Dry run - no changes",
      status: "SUCCESS",
    });

    // Clear checkpoint
    if (executorAgent) {
      executorAgent.getCheckpointManager().clearCheckpoint(issueId);
    }
  }

  // Start the agent run with SRE's selected option
  const started = startAgentRun({
    scenario: input.scenario || "pod-crash",
    dryRun,
    metricsUrl: input.metricsUrl || undefined,
    strictLive: typeof input.strictLive === "boolean" ? input.strictLive : true,
    targetName: targetName || undefined,
    targetNamespace: targetName ? targetNamespace : undefined,
    targetKind: targetName ? targetKind : undefined,
    llmStrategyType: llmStrategy?.type,
    llmStrategyReplicas: llmStrategy?.replicas,
    llmStrategyReason: llmStrategy?.reason,
    llmOptionSteps: selectedOptionSteps,
    sreSelectedOption: selectedOption.id,
    sreSelectionReason: remediationOptions.selection_reason,
  });

  return {
    ok: true,
    code: 200,
    data: {
      status: started,
      snapshot: getRunnerSnapshot().status,
      message: skipSREValidation
        ? "Execution complete (SRE validation skipped)"
        : "SRE decision received and execution started",
      executionResult,
    },
  };
}

export async function runHealingOrchestrator(input) {
  const scenario = input.scenario || "pod-crash";
  const dryRun = typeof input.dryRun === "boolean" ? input.dryRun : false;
  const metricsUrl = (input.metricsUrl || process.env.METRICS_URL || "").trim();
  const strictLive = typeof input.strictLive === "boolean" ? input.strictLive : true;
  const targetName = (input.targetName || "").trim();
  const targetNamespace = (input.targetNamespace || "default").trim() || "default";
  const targetKind = input.targetKind || "pod";
  const autoExecute = input.autoExecute === true; // Skip SRE decision if true

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

  // Get healing plan from LLM
  const plan = await getGeminiHealingPlan({ scenario, dryRun, metricsUrl, targetName, targetNamespace, targetKind });

  // Start agent run
  const started = startAgentRun({
    scenario,
    dryRun,
    metricsUrl: metricsUrl || undefined,
    strictLive,
    targetName: targetName || undefined,
    targetNamespace: targetName ? targetNamespace : undefined,
    targetKind: targetName ? targetKind : undefined,
  });

  const issueId = started.activeIssueId;
  if (!issueId) {
    return {
      ok: false,
      code: 500,
      error: "failed_to_start",
      details: "Could not start healing run",
    };
  }

  const targetLabel = targetName ? `${targetNamespace}/${targetName} (${targetKind})` : "auto-detected workload";

  // Log start
  pushRunnerLog({
    issue_id: issueId,
    agent_name: "Orchestrator",
    event_type: "ANALYZING",
    description: `Self-heal trigger accepted (scenario=${scenario}, dryRun=${dryRun ? "true" : "false"}, target=${targetName || "auto"}).`,
    action_taken: targetName ? `Prioritizing ${targetLabel}` : "Trigger received",
    status: "IN_PROGRESS",
  });

  pushRunnerLog({
    issue_id: issueId,
    agent_name: "GeminiKnowledgeBase",
    event_type: "ANALYZING",
    description: targetName ? `${plan.summary} Target: ${targetNamespace}/${targetName}.` : plan.summary,
    action_taken: `Plan steps: ${(plan.steps || []).join(" | ") || "n/a"}`,
    status: "IN_PROGRESS",
    confidence: typeof plan.confidence === "number" ? plan.confidence : undefined,
    reasoning: `source=${plan.source}`,
    raw: { plan },
  });

  // Generate remediation options via LLM
  const remediationOptions = await getRemediationOptions({
    scenario,
    rootCause: targetName || "unknown-pod",
    failureChain: [],
    affectedCount: 0,
  });

  // Log options generation
  pushRunnerLog({
    issue_id: issueId,
    agent_name: "RCAAgent",
    event_type: "REMEDIATION_OPTIONS",
    description: `Generated ${remediationOptions.options?.length || 0} remediation options for SRE review`,
    action_taken: "Waiting for SRE decision",
    status: "AWAITING_SRE_DECISION",
    raw: { options: remediationOptions.options, rootCause: remediationOptions.root_cause },
  });

  // If auto-execute is enabled, use the LLM's recommended option
  if (autoExecute) {
    const recommendedOption = remediationOptions.options?.find(
      (opt) => opt.id === remediationOptions.selected_option
    ) || remediationOptions.options?.[0];

    if (recommendedOption) {
      return executeWithDecision(issueId, input, plan, remediationOptions, recommendedOption);
    }
  }

  // Store pending decision state
  const pendingDecision = {
    input,
    plan,
    remediationOptions,
    createdAt: new Date().toISOString(),
    status: "awaiting_sre_decision",
  };
  pendingDecisions.set(issueId, pendingDecision);

  // Return with pending state - execution will continue after SRE decision
  return {
    ok: true,
    code: 200,
    awaitingSREDecision: true,
    data: {
      issueId,
      status: {
        state: "awaiting_sre_decision",
        totalLogs: getRunnerSnapshot().logs?.length || 0,
        activeAgent: "SRE",
        activeAction: "Waiting for SRE to select remediation option",
        activeIssueId: issueId,
      },
      snapshot: getRunnerSnapshot().status,
      remediationOptions: {
        options: remediationOptions.options,
        root_cause: remediationOptions.root_cause || targetName || "unknown",
        issue_id: issueId,
        target: { name: targetName, namespace: targetNamespace, kind: targetKind },
      },
    },
  };
}
