import "server-only";

import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  AgentRunnerStatus,
  HealingEventType,
  HealingLogStatus,
  HealingScenario,
  IssueLifecycle,
  StructuredHealingLog,
} from "@/lib/healing/types";
import { publishObservabilityEvent, upsertIssueLifecycle } from "@/lib/observability/events";

type StreamEvent =
  | { type: "init"; payload: { status: AgentRunnerStatus; logs: StructuredHealingLog[]; lifecycle: IssueLifecycle[] } }
  | { type: "log"; payload: StructuredHealingLog }
  | { type: "status"; payload: AgentRunnerStatus }
  | { type: "lifecycle"; payload: IssueLifecycle[] };

type StartOptions = {
  scenario?: HealingScenario;
  dryRun?: boolean;
  metricsUrl?: string;
  strictLive?: boolean;
  targetName?: string;
  targetNamespace?: string;
  targetKind?: "pod" | "deployment";
  llmStrategyType?: "restart_pod" | "restart_deployment" | "scale_up" | "rollback";
  llmStrategyReplicas?: number;
  llmStrategyReason?: string;
  llmOptionSteps?: string[];
  sreSelectedOption?: string;
  sreSelectionReason?: string;
};

type VerificationResult = {
  verified: boolean;
  reason: string;
  retryRecommended?: boolean;
  alternativeOptions?: Array<{
    id: string;
    name: string;
    description: string;
  }>;
};

type ExecutionResult = {
  success: boolean;
  fixType?: string;
  target?: string;
  message?: string;
  verification?: {
    verified: boolean;
    reason?: string;
  };
};

class HealingAgentRunnerService {
  private logs: StructuredHealingLog[] = [];
  private listeners = new Set<(event: StreamEvent) => void>();
  private issueLifecycle = new Map<string, IssueLifecycle>();
  private status: AgentRunnerStatus = {
    state: "idle",
    totalLogs: 0,
  };
  private runPromise: Promise<void> | null = null;
  private verificationCallbacks = new Set<(result: VerificationResult) => void>();
  private sreDecisionCallbacks = new Set<(issueId: string, options: Array<{ id: string; name: string; description: string }>) => void>();

  /**
   * Register callback for verification results
   */
  onVerificationResult(callback: (result: VerificationResult) => void) {
    this.verificationCallbacks.add(callback);
    return () => this.verificationCallbacks.delete(callback);
  }

  /**
   * Register callback for SRE decision requests
   */
  onSREDecisionRequired(callback: (issueId: string, options: Array<{ id: string; name: string; description: string }>) => void) {
    this.sreDecisionCallbacks.add(callback);
    return () => this.sreDecisionCallbacks.delete(callback);
  }

  /**
   * Handle verification failure - notify callbacks and update state
   */
  handleVerificationFailure(issueId: string, result: VerificationResult) {
    this.appendLog({
      agent_name: "VerificationAgent",
      event_type: "VERIFICATION",
      issue_id: issueId,
      description: `Verification failed: ${result.reason}`,
      action_taken: result.retryRecommended ? "Recommending retry with alternative options" : "Manual intervention required",
      status: "VERIFICATION_FAILED",
      raw: { result },
    });

    this.status = {
      ...this.status,
      state: "verification_failed",
      verificationFailed: true,
      verificationReason: result.reason,
      retryOptions: result.alternativeOptions,
      activeAgent: "SRE",
      activeAction: result.retryRecommended
        ? "Verification failed - awaiting SRE decision on retry"
        : "Verification failed - manual intervention required",
    };

    this.emit({ type: "status", payload: this.status });

    // Notify verification callbacks
    for (const cb of this.verificationCallbacks) {
      try {
        cb(result);
      } catch {
        // Ignore callback errors
      }
    }
  }

  /**
   * Set state to awaiting SRE decision
   */
  setAwaitingSREDecision(issueId: string, options: Array<{ id: string; name: string; description: string }>, rootCause?: string) {
    this.status = {
      ...this.status,
      state: "awaiting_sre_decision",
      sreDecisionRequired: true,
      remediationOptions: options,
      rootCause,
      activeAgent: "SRE",
      activeAction: "Awaiting SRE decision on remediation options",
      activeIssueId: issueId,
    };

    this.appendLog({
      agent_name: "Orchestrator",
      event_type: "DECISION",
      issue_id: issueId,
      description: `Awaiting SRE decision on ${options.length} remediation options`,
      action_taken: "Presenting options to SRE",
      status: "AWAITING_SRE_DECISION",
      raw: { options, rootCause },
    });

    this.emit({ type: "status", payload: this.status });
    this.emit({ type: "lifecycle", payload: this.getIssueLifecycle() });

    // Notify SRE decision callbacks
    for (const cb of this.sreDecisionCallbacks) {
      try {
        cb(issueId, options);
      } catch {
        // Ignore callback errors
      }
    }
  }

  /**
   * Resume after SRE decision
   */
  resumeAfterSREDecision(issueId: string, selectedOptionId: string, reason?: string) {
    this.appendLog({
      agent_name: "SRE",
      event_type: "DECISION",
      issue_id: issueId,
      description: `SRE selected option: ${selectedOptionId}`,
      action_taken: reason || "SRE decision received",
      status: "IN_PROGRESS",
    });

    this.status = {
      ...this.status,
      state: "running",
      sreDecisionRequired: false,
      activeAgent: "ExecutionerAgent",
      activeAction: `Executing SRE-selected option: ${selectedOptionId}`,
    };

    this.emit({ type: "status", payload: this.status });
  }

  /**
   * 🔹 Step 4: Set state to awaiting SRE validation (after execution + verification)
   */
  setAwaitingSREValidation(
    issueId: string,
    executionResult: ExecutionResult,
    checkpointAvailable: boolean = false
  ) {
    this.status = {
      ...this.status,
      state: "awaiting_sre_validation",
      sreValidationRequired: true,
      executionResult,
      checkpointAvailable,
      activeAgent: "SRE",
      activeAction: "Awaiting SRE validation of execution results",
      activeIssueId: issueId,
    };

    this.appendLog({
      agent_name: "Orchestrator",
      event_type: "DECISION",
      issue_id: issueId,
      description: `Execution completed. Awaiting SRE validation. Fix: ${executionResult.fixType}, Success: ${executionResult.success}`,
      action_taken: checkpointAvailable
        ? "SRE can ACCEPT (keep changes) or REJECT (rollback to checkpoint)"
        : "SRE review required - no checkpoint available for rollback",
      status: "AWAITING_SRE_VALIDATION",
      raw: { executionResult, checkpointAvailable },
    });

    this.emit({ type: "status", payload: this.status });
    this.emit({ type: "lifecycle", payload: this.getIssueLifecycle() });
  }

  /**
   * 🔹 Step 5a: SRE accepts the execution
   */
  sreAcceptExecution(issueId: string, reason?: string) {
    this.appendLog({
      agent_name: "SRE",
      event_type: "DECISION",
      issue_id: issueId,
      description: `SRE ACCEPTED the execution results`,
      action_taken: reason || "Fix accepted by SRE",
      status: "SUCCESS",
    });

    this.status = {
      ...this.status,
      state: "completed",
      sreValidationRequired: false,
      outcome: "fixed",
      activeAgent: "Orchestrator",
      activeAction: "SRE accepted execution - fix finalized",
      finishedAt: new Date().toISOString(),
    };

    this.emit({ type: "status", payload: this.status });
    this.emit({ type: "lifecycle", payload: this.getIssueLifecycle() });

    return { ok: true, action: "accepted" };
  }

  /**
   * 🔹 Step 5b: SRE rejects the execution - rollback required
   */
  async sreRejectExecution(issueId: string, rollbackResult: { ok: boolean; message?: string }, reason?: string) {
    this.appendLog({
      agent_name: "SRE",
      event_type: "DECISION",
      issue_id: issueId,
      description: `SRE REJECTED the execution. Rollback ${rollbackResult.ok ? "successful" : "failed"}.`,
      action_taken: reason || `Fix rejected by SRE. ${rollbackResult.message || ""}`,
      status: "SRE_REJECTED",
      raw: { rollbackResult },
    });

    this.status = {
      ...this.status,
      state: rollbackResult.ok ? "completed" : "failed",
      sreValidationRequired: false,
      outcome: rollbackResult.ok ? "no-op" : "failed",
      activeAgent: "Orchestrator",
      activeAction: rollbackResult.ok
        ? "SRE rejected - rollback completed"
        : "SRE rejected - rollback failed, manual intervention required",
      finishedAt: new Date().toISOString(),
    };

    this.emit({ type: "status", payload: this.status });
    this.emit({ type: "lifecycle", payload: this.getIssueLifecycle() });

    return { ok: rollbackResult.ok, action: "rejected", rollback: rollbackResult };
  }

  startHealing(options: StartOptions = {}) {
    if (this.status.state === "running") {
      return this.status;
    }

    const scenario = options.scenario || "pod-crash";
    const startedAt = new Date().toISOString();
    const issueId = `${scenario}-${startedAt}`;

    this.logs = [];
    this.issueLifecycle.clear();
    this.status = {
      state: "running",
      startedAt,
      scenario,
      totalLogs: 0,
      activeAgent: "Orchestrator",
      activeAction: options.targetName
        ? `starting self-healing run for ${options.targetNamespace || "default"}/${options.targetName}`
        : "starting self-healing run",
      activeIssueId: issueId,
      targetName: options.targetName,
      targetNamespace: options.targetNamespace,
      targetKind: options.targetKind,
    };
    this.emit({ type: "status", payload: this.status });

    this.appendLog({
      agent_name: "Orchestrator",
      event_type: "ANALYZING",
      issue_id: issueId,
      description: options.targetName
        ? `Self-healing cycle started (scenario=${scenario}, target=${options.targetNamespace || "default"}/${options.targetName})`
        : `Self-healing cycle started (scenario=${scenario})`,
      action_taken: options.targetName ? "Prioritizing explicit workload target" : "Fetching live cluster metrics",
      status: "IN_PROGRESS",
    });

    this.runPromise = (async () => {
      try {
        await this.runHealingProcess(issueId, options);
        const outcome = this.getRunOutcome();

        this.status = {
          ...this.status,
          state: "completed",
          finishedAt: new Date().toISOString(),
          activeAgent: "Orchestrator",
          activeAction: outcome === "fixed" ? "remediation verified" : "run completed without remediation",
          outcome,
          targetName: options.targetName,
          targetNamespace: options.targetNamespace,
          targetKind: options.targetKind,
          totalLogs: this.logs.length,
        };
        this.emit({ type: "status", payload: this.status });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.status = {
          ...this.status,
          state: "failed",
          finishedAt: new Date().toISOString(),
          activeAgent: "Orchestrator",
          activeAction: "execution halted",
          outcome: "failed",
          targetName: options.targetName,
          targetNamespace: options.targetNamespace,
          targetKind: options.targetKind,
          lastError: message,
          totalLogs: this.logs.length,
        };

        this.appendLog({
          agent_name: "Orchestrator",
          event_type: "FAILED",
          issue_id: issueId,
          description: message,
          action_taken: "Execution halted",
          status: "FAILED",
        });

        this.emit({ type: "status", payload: this.status });
      } finally {
        this.runPromise = null;
      }
    })();

    return this.status;
  }

  getAgentStatus() {
    return this.status;
  }

  resetSession() {
    this.logs = [];
    this.issueLifecycle.clear();
    this.status = {
      state: "idle",
      totalLogs: 0,
    };
    this.emit({
      type: "status",
      payload: this.status,
    });
    this.emit({
      type: "log",
      payload: undefined as never,
    });
    this.emit({
      type: "lifecycle",
      payload: [],
    });
  }

  appendExternalLog(input: {
    issue_id: string;
    agent_name?: string;
    event_type?: HealingEventType;
    description: string;
    action_taken?: string;
    status?: HealingLogStatus;
    confidence?: number;
    reasoning?: string;
    raw?: Record<string, unknown>;
  }) {
    this.appendLog({
      agent_name: input.agent_name || "Orchestrator",
      event_type: input.event_type || "ANALYZING",
      issue_id: input.issue_id,
      description: input.description,
      action_taken: input.action_taken || "Processing",
      status: input.status || "IN_PROGRESS",
      confidence: input.confidence,
      reasoning: input.reasoning,
      raw: input.raw,
    });
  }

  getExecutionLogs(filters?: {
    agent?: string;
    status?: HealingLogStatus;
    issue_id?: string;
    from?: string;
    to?: string;
  }) {
    let data = [...this.logs];
    if (filters?.agent) {
      data = data.filter((l) => l.agent_name === filters.agent);
    }
    if (filters?.status) {
      data = data.filter((l) => l.status === filters.status);
    }
    if (filters?.issue_id) {
      data = data.filter((l) => l.issue_id === filters.issue_id);
    }
    if (filters?.from) {
      const fromTs = Date.parse(filters.from);
      if (!Number.isNaN(fromTs)) {
        data = data.filter((l) => Date.parse(l.timestamp) >= fromTs);
      }
    }
    if (filters?.to) {
      const toTs = Date.parse(filters.to);
      if (!Number.isNaN(toTs)) {
        data = data.filter((l) => Date.parse(l.timestamp) <= toTs);
      }
    }
    return data;
  }

  getIssueLifecycle() {
    return Array.from(this.issueLifecycle.values()).sort((a, b) => {
      const ta = a.detected_at || a.analysis_started_at || a.fix_applied_at || a.resolved_at || "";
      const tb = b.detected_at || b.analysis_started_at || b.fix_applied_at || b.resolved_at || "";
      return ta.localeCompare(tb);
    });
  }

  subscribe(listener: (event: StreamEvent) => void) {
    this.listeners.add(listener);
    listener({
      type: "init",
      payload: {
        status: this.status,
        logs: this.logs,
        lifecycle: this.getIssueLifecycle(),
      },
    });
    return () => this.listeners.delete(listener);
  }

  private emit(event: StreamEvent) {
    for (const l of this.listeners) {
      l(event);
    }
  }

  private appendLog(input: {
    agent_name: string;
    event_type: HealingEventType;
    issue_id: string;
    description: string;
    action_taken: string;
    status: HealingLogStatus;
    confidence?: number;
    reasoning?: string;
    raw?: Record<string, unknown>;
  }) {
    const log: StructuredHealingLog = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...input,
    };

    this.logs.push(log);
    if (this.logs.length > 2000) {
      this.logs = this.logs.slice(-2000);
    }

    this.status = {
      ...this.status,
      totalLogs: this.logs.length,
      activeAgent: log.agent_name,
      activeAction: log.action_taken,
      activeIssueId: log.issue_id,
    };

    this.updateLifecycle(log);
    this.emit({ type: "log", payload: log });
    this.emit({ type: "status", payload: this.status });
    this.emit({ type: "lifecycle", payload: this.getIssueLifecycle() });

    void this.persistLog(log);
  }

  private async persistLog(log: StructuredHealingLog) {
    try {
      await publishObservabilityEvent({
        correlation_id: log.issue_id,
        event_type:
          log.event_type === "DETECTED"
            ? "ai_detection"
            : log.event_type === "RESOLVED"
              ? "resolution"
              : "ai_action",
        related_resource: log.agent_name,
        related_kind: "agent",
        severity:
          log.status === "FAILED"
            ? "critical"
            : log.status === "IN_PROGRESS"
              ? "warning"
              : "info",
        title: log.description,
        details: {
          agent_name: log.agent_name,
          action_taken: log.action_taken,
          status: log.status,
          event_type: log.event_type,
        },
        timestamp: log.timestamp,
      });

      const lifecycle = this.issueLifecycle.get(log.issue_id);
      if (lifecycle) {
        await upsertIssueLifecycle({
          issue_id: lifecycle.issue_id,
          title: lifecycle.title,
          status: lifecycle.status,
          detected_at: lifecycle.detected_at,
          analysis_started_at: lifecycle.analysis_started_at,
          fix_applied_at: lifecycle.fix_applied_at,
          resolved_at: lifecycle.resolved_at,
          failed_at: lifecycle.failed_at,
        });
      }
    } catch {
      // Best effort persistence only; live run should continue even if storage is unavailable.
    }
  }

  private updateLifecycle(log: StructuredHealingLog) {
    const existing = this.issueLifecycle.get(log.issue_id) || {
      issue_id: log.issue_id,
      title: log.description,
      status: "OPEN" as HealingLogStatus,
    };

    const next: IssueLifecycle = { ...existing, status: log.status };

    if (log.event_type === "DETECTED" && !next.detected_at) {
      next.detected_at = log.timestamp;
    }
    if (log.event_type === "ANALYZING" && !next.analysis_started_at) {
      next.analysis_started_at = log.timestamp;
    }
    if (log.event_type === "FIXING" && !next.fix_applied_at) {
      next.fix_applied_at = log.timestamp;
    }
    if (log.event_type === "RESOLVED") {
      next.resolved_at = log.timestamp;
      next.status = "SUCCESS";
    }
    if (log.event_type === "FAILED") {
      next.failed_at = log.timestamp;
      next.status = "FAILED";
    }

    this.issueLifecycle.set(log.issue_id, next);
  }

  private runHealingProcess(issueId: string, options: StartOptions) {
    const scriptPath = path.resolve(process.cwd(), "src", "ai-agents", "self-healing-system", "main.js");
    const metricsUrl = options.metricsUrl?.trim() || process.env.METRICS_URL || "";
    const dryRun = typeof options.dryRun === "boolean" ? options.dryRun : false;
    const strictLive = typeof options.strictLive === "boolean" ? options.strictLive : true;
    const childArgs = [scriptPath];

    if (Array.isArray(options.llmOptionSteps) && options.llmOptionSteps.length > 0) {
      const encoded = Buffer.from(JSON.stringify(options.llmOptionSteps), "utf8").toString("base64");
      childArgs.push(`--llm-option-steps-b64=${encoded}`);
    }
    if (options.llmStrategyType) {
      childArgs.push(`--llm-strategy-type=${options.llmStrategyType}`);
    }
    if (typeof options.llmStrategyReplicas === "number" && Number.isFinite(options.llmStrategyReplicas)) {
      childArgs.push(`--llm-strategy-replicas=${String(options.llmStrategyReplicas)}`);
    }
    if (options.llmStrategyReason) {
      const encoded = Buffer.from(options.llmStrategyReason, "utf8").toString("base64");
      childArgs.push(`--llm-strategy-reason-b64=${encoded}`);
    }

    return new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, childArgs, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          METRICS_URL: metricsUrl,
          DRY_RUN: dryRun ? "true" : "false",
          STRICT_LIVE: strictLive ? "true" : "false",
          MANUAL_TARGET_NAME: options.targetName || "",
          MANUAL_TARGET_NAMESPACE: options.targetNamespace || "default",
          MANUAL_TARGET_KIND: options.targetKind || "pod",
          LLM_STRATEGY_TYPE: options.llmStrategyType || "",
          LLM_STRATEGY_REPLICAS:
            typeof options.llmStrategyReplicas === "number" && Number.isFinite(options.llmStrategyReplicas)
              ? String(options.llmStrategyReplicas)
              : "",
          LLM_STRATEGY_REASON: options.llmStrategyReason || "",
          LLM_OPTION_STEPS_JSON:
            Array.isArray(options.llmOptionSteps) && options.llmOptionSteps.length > 0
              ? JSON.stringify(options.llmOptionSteps)
              : "",
          LOG_LEVEL: process.env.LOG_LEVEL || "info",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk: Buffer) => {
        this.ingestProcessLines(chunk.toString("utf8"), issueId, false);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        this.ingestProcessLines(chunk.toString("utf8"), issueId, true);
      });

      child.on("error", (err) => {
        reject(err);
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Self-healing process exited with code ${code ?? -1}`));
      });
    });
  }

  private ingestProcessLines(raw: string, issueId: string, isStderr: boolean) {
    const lines = raw
      .split(/\r?\n/)
      .map((line) => this.stripAnsi(line).trim())
      .filter(Boolean);

    for (const line of lines) {
      const mapped = this.mapLineToLog(line, issueId, isStderr);
      this.appendLog(mapped);
    }
  }

  private mapLineToLog(
    line: string,
    issueId: string,
    isStderr: boolean,
  ): {
    agent_name: string;
    event_type: HealingEventType;
    issue_id: string;
    description: string;
    action_taken: string;
    status: HealingLogStatus;
  } {
    if (isStderr || line.includes("[ERROR]")) {
      return {
        agent_name: "Orchestrator",
        event_type: "FAILED",
        issue_id: issueId,
        description: line,
        action_taken: "Execution error captured",
        status: "FAILED",
      };
    }

    if (line.includes("[ANALYSIS]")) {
      return {
        agent_name: "ObserverAgent",
        event_type: "ANALYZING",
        issue_id: issueId,
        description: line,
        action_taken: "Analyzing cluster state",
        status: "IN_PROGRESS",
      };
    }

    if (line.includes("[RCA]")) {
      return {
        agent_name: "RCAAgent",
        event_type: "ANALYZING",
        issue_id: issueId,
        description: line,
        action_taken: "Tracing dependencies and root cause",
        status: "IN_PROGRESS",
      };
    }

    if (line.includes("[FIX]")) {
      return {
        agent_name: "ExecutionerAgent",
        event_type: "FIXING",
        issue_id: issueId,
        description: line,
        action_taken: "Applying remediation",
        status: "IN_PROGRESS",
      };
    }

    if (line.includes("[ISSUE]")) {
      return {
        agent_name: "DetectorAgent",
        event_type: "DETECTED",
        issue_id: issueId,
        description: line,
        action_taken: "Issue confirmed",
        status: "OPEN",
      };
    }

    if (line.includes("[SUCCESS]") || /Success:\s*✅\s*YES/i.test(line)) {
      return {
        agent_name: "Orchestrator",
        event_type: "RESOLVED",
        issue_id: issueId,
        description: line,
        action_taken: "Run completed successfully",
        status: "SUCCESS",
      };
    }

    if (line.includes("[VERIFICATION]")) {
      const failed = line.toLowerCase().includes("failed") || line.toLowerCase().includes("not ready");
      return {
        agent_name: "VerificationAgent",
        event_type: "VERIFICATION",
        issue_id: issueId,
        description: line,
        action_taken: failed ? "Verification failed - awaiting SRE decision" : "Fix verified successfully",
        status: failed ? "VERIFICATION_FAILED" : "SUCCESS",
      };
    }

    if (line.includes("[SRE_DECISION]") || line.includes("[DECISION]")) {
      return {
        agent_name: "SRE",
        event_type: "DECISION",
        issue_id: issueId,
        description: line,
        action_taken: "SRE decision point",
        status: "AWAITING_SRE_DECISION",
      };
    }

    if (line.includes("[VERIFY]") || line.toLowerCase().includes("verifying fix")) {
      return {
        agent_name: "VerificationAgent",
        event_type: "VERIFICATION",
        issue_id: issueId,
        description: line,
        action_taken: "Verifying remediation",
        status: "IN_PROGRESS",
      };
    }

    if (line.includes("[CHECKPOINT]")) {
      return {
        agent_name: "ExecutionerAgent",
        event_type: "FIXING",
        issue_id: issueId,
        description: line,
        action_taken: "Captured pre-execution checkpoint",
        status: "IN_PROGRESS",
      };
    }

    if (line.includes("[ROLLBACK]")) {
      const success = !line.toLowerCase().includes("failed");
      return {
        agent_name: "ExecutionerAgent",
        event_type: "FIXING",
        issue_id: issueId,
        description: line,
        action_taken: success ? "Rollback executed" : "Rollback failed",
        status: success ? "IN_PROGRESS" : "FAILED",
      };
    }

    if (line.includes("[SRE_VALIDATION]") || line.includes("awaiting SRE validation")) {
      return {
        agent_name: "Orchestrator",
        event_type: "DECISION",
        issue_id: issueId,
        description: line,
        action_taken: "Awaiting SRE validation of execution",
        status: "AWAITING_SRE_VALIDATION",
      };
    }

    return {
      agent_name: "Orchestrator",
      event_type: "ANALYZING",
      issue_id: issueId,
      description: line,
      action_taken: "Processing",
      status: "IN_PROGRESS",
    };
  }

  private stripAnsi(text: string) {
    return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  }

  private getRunOutcome(): "fixed" | "no-op" {
    const lifecycle = this.getIssueLifecycle();
    const hasAppliedFix = lifecycle.some((item) => Boolean(item.fix_applied_at));
    return hasAppliedFix ? "fixed" : "no-op";
  }
}

declare global {
  var __healingRunnerService: HealingAgentRunnerService | undefined;
}

export const healingRunnerService = globalThis.__healingRunnerService || new HealingAgentRunnerService();
if (!globalThis.__healingRunnerService) {
  globalThis.__healingRunnerService = healingRunnerService;
}
