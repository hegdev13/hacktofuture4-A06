import "server-only";

import crypto from "node:crypto";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
  remediationId?: string;
  remediationPreference?: "restart-workload" | "scale-replicas" | "dependency-first" | "custom-command";
  customCommand?: string;
};

type RollbackSnapshot = {
  capturedAt: string;
  issueId: string;
  targetName: string;
  targetNamespace: string;
  targetKind: "pod" | "deployment";
  deploymentName: string;
  deploymentManifest: {
    apiVersion: string;
    kind: string;
    metadata: {
      name: string;
      namespace: string;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    };
    spec: Record<string, unknown>;
  };
};

class HealingAgentRunnerService {
  readonly version = "2026-04-17-custom-remediation-v6";
  private logs: StructuredHealingLog[] = [];
  private listeners = new Set<(event: StreamEvent) => void>();
  private issueLifecycle = new Map<string, IssueLifecycle>();
  private status: AgentRunnerStatus = {
    state: "idle",
    totalLogs: 0,
  };
  private rollbackSnapshot: RollbackSnapshot | null = null;
  private runPromise: Promise<void> | null = null;

  startHealing(options: StartOptions = {}) {
    if (this.status.state === "running") {
      return this.status;
    }

    const scenario = options.scenario || "pod-crash";
    const startedAt = new Date().toISOString();
    const issueId = `${scenario}-${startedAt}`;

    this.logs = [];
    this.issueLifecycle.clear();
    this.rollbackSnapshot = null;
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

    this.captureRollbackSnapshot(options, issueId);

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
    this.rollbackSnapshot = null;
    this.status = {
      state: "idle",
      totalLogs: 0,
    };
    this.emit({
      type: "status",
      payload: this.status,
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

  getRollbackSnapshot() {
    return this.rollbackSnapshot;
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
    const customSelected = options.remediationId === "custom-command" || options.remediationPreference === "custom-command";
    if (customSelected && options.customCommand?.trim()) {
      return this.runCustomCommand(issueId, options.customCommand.trim(), options);
    }

    const scriptPath = path.resolve(process.cwd(), "src", "ai-agents", "self-healing-system", "main.js");
    const metricsUrl = options.metricsUrl?.trim() || process.env.METRICS_URL || "";
    const dryRun = typeof options.dryRun === "boolean" ? options.dryRun : false;
    const strictLive = typeof options.strictLive === "boolean" ? options.strictLive : true;

    return new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          METRICS_URL: metricsUrl,
          DRY_RUN: dryRun ? "true" : "false",
          STRICT_LIVE: strictLive ? "true" : "false",
          MANUAL_TARGET_NAME: options.targetName || "",
          MANUAL_TARGET_NAMESPACE: options.targetNamespace || "default",
          MANUAL_TARGET_KIND: options.targetKind || "pod",
          REMEDIATION_ID: options.remediationId || "",
          REMEDIATION_PREFERENCE: options.remediationPreference || "",
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

  private runCustomCommand(issueId: string, command: string, options: StartOptions) {
    return new Promise<void>((resolve, reject) => {
      this.appendLog({
        agent_name: "ExecutionerAgent",
        event_type: "FIXING",
        issue_id: issueId,
        description: `Executing custom healing command: ${command}`,
        action_taken: options.remediationId
          ? `Running SRE custom command from ${options.remediationId}`
          : "Running SRE custom command",
        status: "IN_PROGRESS",
      });

      const isWindows = process.platform === "win32";
      const child = isWindows
        ? spawn("powershell", ["-NoProfile", "-Command", command], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] })
        : spawn("sh", ["-lc", command], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        reject(err);
      });

      child.on("close", (code) => {
        if (code === 0) {
          const verification = this.verifyTargetHealth(options);

          this.appendLog({
            agent_name: "ExecutionerAgent",
            event_type: "ANALYZING",
            issue_id: issueId,
            description: verification.verified
              ? "Custom command executed and target health verified."
              : `Custom command executed, but target not verified healthy: ${verification.reason}`,
            action_taken: verification.verified
              ? "Execution completed with post-command health verification"
              : "Execution completed; awaiting healthy target state",
            status: "IN_PROGRESS",
          });

          if (verification.verified) {
            this.appendLog({
              agent_name: "Orchestrator",
              event_type: "RESOLVED",
              issue_id: issueId,
              description: "Custom command completed successfully and target is healthy.",
              action_taken: "Marked as resolved after health verification",
              status: "SUCCESS",
              raw: {
                command,
                verification,
                stdout: stdout.trim().slice(0, 4000),
              },
            });
          }

          resolve();
          return;
        }

        const details = (stderr || stdout || `exit code ${code ?? -1}`).trim();
        reject(new Error(`Custom command failed: ${details}`));
      });
    });
  }

  private verifyTargetHealth(options: StartOptions): { verified: boolean; reason: string } {
    const targetName = (options.targetName || "").trim();
    const targetNamespace = (options.targetNamespace || "default").trim() || "default";
    const targetKind = options.targetKind || "pod";

    if (!targetName) {
      return { verified: false, reason: "No target name provided for verification" };
    }

    try {
      if (targetKind === "deployment") {
        const result = spawnSync(
          "kubectl",
          ["rollout", "status", `deployment/${targetName}`, "-n", targetNamespace, "--timeout=90s"],
          { cwd: process.cwd(), encoding: "utf8" },
        );

        if (result.status !== 0) {
          return {
            verified: false,
            reason: (result.stderr || result.stdout || "deployment rollout did not become healthy").trim(),
          };
        }

        const depState = spawnSync(
          "kubectl",
          ["get", "deployment", targetName, "-n", targetNamespace, "-o", "json"],
          { cwd: process.cwd(), encoding: "utf8" },
        );

        if (depState.status !== 0 || !depState.stdout) {
          return {
            verified: false,
            reason: (depState.stderr || depState.stdout || "unable to read deployment state").trim(),
          };
        }

        const dep = JSON.parse(depState.stdout) as {
          spec?: { replicas?: number };
          status?: { replicas?: number; availableReplicas?: number };
        };

        const desired = Number(dep?.spec?.replicas ?? dep?.status?.replicas ?? 0);
        const available = Number(dep?.status?.availableReplicas ?? 0);

        if (desired <= 0) {
          return {
            verified: false,
            reason: "Deployment is at 0 replicas, so workload is not actively healed",
          };
        }

        if (available <= 0) {
          return {
            verified: false,
            reason: `Deployment has desired=${desired} but available=${available}`,
          };
        }

        if (available < desired) {
          return {
            verified: false,
            reason: `Deployment not fully available yet (${available}/${desired})`,
          };
        }

        return { verified: true, reason: `Deployment healthy (${available}/${desired} available)` };

      }

      const podResult = spawnSync("kubectl", ["get", "pod", targetName, "-n", targetNamespace, "-o", "json"], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      if (podResult.status !== 0 || !podResult.stdout) {
        return {
          verified: false,
          reason: (podResult.stderr || podResult.stdout || "unable to read pod state").trim(),
        };
      }

      const pod = JSON.parse(podResult.stdout) as {
        status?: {
          phase?: string;
          conditions?: Array<{ type?: string; status?: string }>;
        };
      };

      const phase = String(pod.status?.phase || "").toLowerCase();
      const ready = Array.isArray(pod.status?.conditions)
        ? pod.status?.conditions.some((cond) => cond.type === "Ready" && cond.status === "True")
        : false;

      if (phase === "running" && ready) {
        return { verified: true, reason: "Pod is running and ready" };
      }

      return {
        verified: false,
        reason: `Pod not ready (phase=${phase || "unknown"})`,
      };
    } catch (error) {
      return {
        verified: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveDeploymentName(targetName: string, targetKind: "pod" | "deployment") {
    if (targetKind === "deployment") {
      return targetName;
    }

    const parts = targetName.split("-");
    if (parts.length >= 3) {
      return parts.slice(0, -2).join("-");
    }
    if (parts.length >= 2) {
      return parts.slice(0, -1).join("-");
    }
    return targetName;
  }

  private captureRollbackSnapshot(options: StartOptions, issueId: string) {
    const targetName = (options.targetName || "").trim();
    if (!targetName) {
      return;
    }

    const targetNamespace = (options.targetNamespace || "default").trim() || "default";
    const targetKind = (options.targetKind || "pod") as "pod" | "deployment";
    const deploymentName = this.resolveDeploymentName(targetName, targetKind);

    const depResult = spawnSync(
      "kubectl",
      ["get", "deployment", deploymentName, "-n", targetNamespace, "-o", "json"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    if (depResult.status !== 0 || !depResult.stdout) {
      this.appendLog({
        agent_name: "ObserverAgent",
        event_type: "ANALYZING",
        issue_id: issueId,
        description: `Pre-heal snapshot unavailable for ${targetNamespace}/${deploymentName}: ${(depResult.stderr || depResult.stdout || "deployment not found").trim()}`,
        action_taken: "Continuing without deployment snapshot rollback baseline",
        status: "IN_PROGRESS",
      });
      return;
    }

    try {
      const parsed = JSON.parse(depResult.stdout) as {
        apiVersion?: string;
        kind?: string;
        metadata?: {
          name?: string;
          namespace?: string;
          labels?: Record<string, string>;
          annotations?: Record<string, string>;
        };
        spec?: Record<string, unknown>;
      };

      if (!parsed.spec || !parsed.metadata?.name) {
        return;
      }

      this.rollbackSnapshot = {
        capturedAt: new Date().toISOString(),
        issueId,
        targetName,
        targetNamespace,
        targetKind,
        deploymentName,
        deploymentManifest: {
          apiVersion: parsed.apiVersion || "apps/v1",
          kind: parsed.kind || "Deployment",
          metadata: {
            name: parsed.metadata.name,
            namespace: parsed.metadata.namespace || targetNamespace,
            labels: parsed.metadata.labels,
            annotations: parsed.metadata.annotations,
          },
          spec: parsed.spec,
        },
      };

      this.appendLog({
        agent_name: "ObserverAgent",
        event_type: "ANALYZING",
        issue_id: issueId,
        description: `Pre-heal deployment snapshot captured for ${targetNamespace}/${deploymentName}.`,
        action_taken: "Stored rollback baseline before remediation",
        status: "IN_PROGRESS",
      });
    } catch {
      // Snapshot capture is best effort; healing continues without rollback baseline.
    }
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
    const hasResolved = this.logs.some((log) => log.event_type === "RESOLVED" && log.status === "SUCCESS");
    return hasResolved ? "fixed" : "no-op";
  }
}

declare global {
  var __healingRunnerService: HealingAgentRunnerService | undefined;
}

if (!globalThis.__healingRunnerService || globalThis.__healingRunnerService.version !== "2026-04-17-custom-remediation-v6") {
  globalThis.__healingRunnerService = new HealingAgentRunnerService();
}

export const healingRunnerService = globalThis.__healingRunnerService;
