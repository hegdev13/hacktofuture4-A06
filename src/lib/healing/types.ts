export type HealingEventType = "DETECTED" | "ANALYZING" | "FIXING" | "RESOLVED" | "FAILED" | "DECISION" | "VERIFICATION";

export type HealingLogStatus = "OPEN" | "IN_PROGRESS" | "SUCCESS" | "FAILED" | "AWAITING_SRE_DECISION" | "VERIFICATION_FAILED" | "AWAITING_SRE_VALIDATION" | "SRE_REJECTED";

export type HealingScenario = "pod-crash" | "high-cpu" | "service-unavailable";

export type HealingTargetKind = "pod" | "deployment";

export type StructuredHealingLog = {
  id: string;
  timestamp: string;
  agent_name: string;
  event_type: HealingEventType;
  issue_id: string;
  description: string;
  action_taken: string;
  status: HealingLogStatus;
  confidence?: number;
  reasoning?: string;
  raw?: Record<string, unknown>;
};

export type IssueLifecycle = {
  issue_id: string;
  title: string;
  detected_at?: string;
  analysis_started_at?: string;
  fix_applied_at?: string;
  resolved_at?: string;
  failed_at?: string;
  status: HealingLogStatus;
};

export type AgentRunnerState = "idle" | "running" | "completed" | "failed" | "awaiting_sre_decision" | "verification_failed" | "awaiting_sre_validation";

export type RemediationOption = {
  id: string;
  name: string;
  description: string;
  steps?: string[];
  confidence?: number;
  cost?: {
    downtime?: string;
    risk_level?: string;
  };
  pros?: string[];
  cons?: string[];
};

export type AgentRunnerStatus = {
  state: AgentRunnerState;
  outcome?: "fixed" | "no-op" | "failed";
  startedAt?: string;
  finishedAt?: string;
  activeAgent?: string;
  activeAction?: string;
  activeIssueId?: string;
  scenario?: HealingScenario;
  targetName?: string;
  targetNamespace?: string;
  targetKind?: HealingTargetKind;
  totalLogs: number;
  lastError?: string;
  // SRE Decision fields
  sreDecisionRequired?: boolean;
  remediationOptions?: RemediationOption[];
  rootCause?: string;
  // Verification feedback
  verificationFailed?: boolean;
  verificationReason?: string;
  retryOptions?: RemediationOption[];
  // SRE Execution Validation fields
  sreValidationRequired?: boolean;
  executionResult?: {
    success: boolean;
    fixType?: string;
    target?: string;
    message?: string;
    verification?: {
      verified: boolean;
      reason?: string;
    };
  };
  checkpointAvailable?: boolean;
};

export type HealingSummary = {
  what_happened: string;
  actions_taken: string;
  final_outcome: string;
  decision_trace: string;
  log_explanations: Array<{
    issue_id: string;
    explanation: string;
  }>;
};
