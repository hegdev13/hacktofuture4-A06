import { spawnSync } from "node:child_process";
import { healingRunnerService } from "@/lib/healing/agent-runner";

export function checkKubectlAccess() {
  const check = spawnSync("kubectl", ["version", "--client"], { encoding: "utf-8" });
  return {
    ok: check.status === 0,
    status: check.status,
    stdout: check.stdout || "",
    stderr: check.stderr || "",
  };
}

export function startAgentRun(options) {
  return healingRunnerService.startHealing(options);
}

export function pushRunnerLog(input) {
  healingRunnerService.appendExternalLog(input);
}

export function getRunnerSnapshot() {
  return {
    status: healingRunnerService.getAgentStatus(),
    lifecycle: healingRunnerService.getIssueLifecycle(),
    logs: healingRunnerService.getExecutionLogs(),
  };
}

export function getAgentStatus() {
  return healingRunnerService.getAgentStatus();
}

/**
 * Set state to awaiting SRE decision
 */
export function setAwaitingSREDecision(issueId, options, rootCause) {
  return healingRunnerService.setAwaitingSREDecision(issueId, options, rootCause);
}

/**
 * Resume after SRE decision
 */
export function resumeAfterSREDecision(issueId, selectedOptionId, reason) {
  return healingRunnerService.resumeAfterSREDecision(issueId, selectedOptionId, reason);
}

/**
 * Handle verification failure
 */
export function handleVerificationFailure(issueId, result) {
  return healingRunnerService.handleVerificationFailure(issueId, result);
}

/**
 * Register callbacks
 */
export function onVerificationResult(callback) {
  return healingRunnerService.onVerificationResult(callback);
}

export function onSREDecisionRequired(callback) {
  return healingRunnerService.onSREDecisionRequired(callback);
}

/**
 * 🔹 Step 4: Set state to awaiting SRE validation (after execution)
 */
export function setAwaitingSREValidation(issueId, executionResult, checkpointAvailable) {
  return healingRunnerService.setAwaitingSREValidation(issueId, executionResult, checkpointAvailable);
}

/**
 * 🔹 Step 5a: SRE accepts execution results
 */
export function sreAcceptExecution(issueId, reason) {
  return healingRunnerService.sreAcceptExecution(issueId, reason);
}

/**
 * 🔹 Step 5b: SRE rejects execution - initiate rollback
 */
export function sreRejectExecution(issueId, rollbackResult, reason) {
  return healingRunnerService.sreRejectExecution(issueId, rollbackResult, reason);
}

/**
 * Get current checkpoint for an issue
 */
export function getCheckpointForIssue(issueId) {
  // This will be implemented by executor agent
  return { issueId, exists: false };
}
