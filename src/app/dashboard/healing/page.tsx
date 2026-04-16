"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, BrainCircuit, PlayCircle, RefreshCw, ShieldAlert, Wrench } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { readSelectedEndpoint as readSelectedEndpointFromApi } from "@/lib/endpoints-client";

type HealingEventType = "DETECTED" | "ANALYZING" | "FIXING" | "RESOLVED" | "FAILED";
type HealingLogStatus = "OPEN" | "IN_PROGRESS" | "SUCCESS" | "FAILED";
type HealingScenario = "pod-crash" | "high-cpu" | "service-unavailable";
type HealingTargetKind = "pod" | "deployment";

type HealingTarget = {
  pod_name: string;
  namespace: string;
  status: string;
  cpu_usage: number | null;
  memory_usage: number | null;
  restart_count: number;
  kind: HealingTargetKind;
};

type DeploymentsResponse = {
  ok?: boolean;
  error?: string;
  deployments?: HealingTarget[];
};

type StructuredHealingLog = {
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

type LlmCallRow = {
  key: string;
  timestamp: string;
  issueId: string;
  task: string;
  service: string;
  issue: string;
  decision: string;
  confidence: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  model: string;
  source: string;
};

type IssueLifecycle = {
  issue_id: string;
  title: string;
  detected_at?: string;
  analysis_started_at?: string;
  fix_applied_at?: string;
  resolved_at?: string;
  failed_at?: string;
  status: HealingLogStatus;
};

type AgentRunnerStatus = {
  state: "idle" | "running" | "completed" | "failed";
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
};

type HealingSummary = {
  what_happened: string;
  actions_taken: string;
  final_outcome: string;
  decision_trace: string;
  log_explanations: Array<{
    issue_id: string;
    explanation: string;
  }>;
};

type RemediationOption = {
  id: string;
  title: string;
  summary: string;
  advantage: string[];
  tradeoff: string[];
  score: number;
  estimatedCost: string;
};

function formatTs(ts?: string) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function statusBadge(status: HealingLogStatus | AgentRunnerStatus["state"]) {
  if (status === "SUCCESS" || status === "completed") return "bg-emerald-100 text-emerald-700";
  if (status === "FAILED" || status === "failed") return "bg-red-100 text-red-700";
  if (status === "IN_PROGRESS" || status === "running") return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-700";
}

function outcomeBadge(outcome?: AgentRunnerStatus["outcome"]) {
  if (outcome === "fixed") return "bg-emerald-100 text-emerald-700";
  if (outcome === "no-op") return "bg-slate-100 text-slate-700";
  if (outcome === "failed") return "bg-red-100 text-red-700";
  return "bg-slate-100 text-slate-700";
}

function eventBadge(eventType: HealingEventType) {
  if (eventType === "DETECTED") return "bg-red-100 text-red-700";
  if (eventType === "ANALYZING") return "bg-blue-100 text-blue-700";
  if (eventType === "FIXING") return "bg-amber-100 text-amber-700";
  if (eventType === "RESOLVED") return "bg-emerald-100 text-emerald-700";
  return "bg-slate-100 text-slate-700";
}

function deploymentNameFromPodName(podName: string) {
  const parts = podName.split("-");
  if (parts.length >= 3) {
    return parts.slice(0, -2).join("-");
  }
  if (parts.length >= 2) {
    return parts.slice(0, -1).join("-");
  }
  return podName;
}

export default function HealingDashboardPage() {
  const [status, setStatus] = useState<AgentRunnerStatus>({ state: "idle", totalLogs: 0 });
  const [logs, setLogs] = useState<StructuredHealingLog[]>([]);
  const [lifecycle, setLifecycle] = useState<IssueLifecycle[]>([]);
  const [summary, setSummary] = useState<HealingSummary | null>(null);
  const [scenario, setScenario] = useState<HealingScenario>("pod-crash");
  const [loadingStart, setLoadingStart] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [timeFilterMinutes, setTimeFilterMinutes] = useState<string>("all");
  const [metricsUrl, setMetricsUrl] = useState<string>("");
  const [dryRun, setDryRun] = useState<boolean>(false);
  const [startError, setStartError] = useState<string>("");
  const [targets, setTargets] = useState<HealingTarget[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState<string>("");
  const [targetKind, setTargetKind] = useState<HealingTargetKind>("pod");
  const [targetLoading, setTargetLoading] = useState(false);
  const [targetError, setTargetError] = useState<string>("");
  const [selectedRemediationId, setSelectedRemediationId] = useState<string>("");
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const envUrl = process.env.NEXT_PUBLIC_METRICS_URL || "";
    if (envUrl) {
      setMetricsUrl(envUrl);
    }
  }, []);

  const fetchSummary = useCallback(async () => {
    setLoadingSummary(true);
    try {
      const res = await fetch("/api/ai-agents/healing/summary", { cache: "no-store" });
      const data = (await res.json()) as { ok: boolean; summary?: HealingSummary };
      if (res.ok && data.ok && data.summary) {
        setSummary(data.summary);
      }
    } catch {
      // Keep UI functional even if summary endpoint is temporarily unavailable.
      setSummary(null);
    } finally {
      setLoadingSummary(false);
    }
  }, []);

  const fetchTargets = useCallback(async () => {
    const sourceUrl = metricsUrl.trim() || (await readSelectedEndpointFromApi().then((ep) => ep?.ngrok_url || "").catch(() => ""));
    if (!sourceUrl) {
      setTargets([]);
      setSelectedTargetId("");
      setTargetError("");
      return;
    }

    setTargetLoading(true);
    setTargetError("");
    try {
      const podsUrl = new URL("/api/dashboard/pods", window.location.origin);
      podsUrl.searchParams.set("ngrok_url", sourceUrl);

      const [podsRes, deployRes] = await Promise.all([
        fetch(podsUrl.toString(), { cache: "no-store" }),
        fetch("/api/dashboard/deployments", { cache: "no-store" }),
      ]);

      const podsData = (await podsRes.json()) as { ok?: boolean; error?: string; pods?: HealingTarget[] };
      if (!podsRes.ok) {
        throw new Error(podsData.error || `Failed to load live pods (${podsRes.status})`);
      }

      const normalizedPods = Array.isArray(podsData.pods)
        ? podsData.pods
            .map((pod) => {
              const rawName = String(pod.pod_name || "").trim();
              const deploymentMatch = rawName.match(/^(.*)\s+\(deployment\)$/i);
              const isDeployment = Boolean(deploymentMatch);
              return {
                pod_name: (deploymentMatch?.[1] || rawName).trim(),
                namespace: pod.namespace || "default",
                status: pod.status,
                cpu_usage: typeof pod.cpu_usage === "number" ? pod.cpu_usage : null,
                memory_usage: typeof pod.memory_usage === "number" ? pod.memory_usage : null,
                restart_count: typeof pod.restart_count === "number" ? pod.restart_count : 0,
                kind: (isDeployment ? "deployment" : "pod") as HealingTargetKind,
              };
            })
        : [];

      const deployData = (await deployRes.json().catch(() => ({}))) as DeploymentsResponse;
      const normalizedDeployments = deployRes.ok && Array.isArray(deployData.deployments) ? deployData.deployments : [];

      const combinedMap = new Map<string, HealingTarget>();
      for (const target of normalizedDeployments) {
        combinedMap.set(`${target.namespace}/${target.kind}/${target.pod_name}`, target);
      }
      for (const target of normalizedPods) {
        combinedMap.set(`${target.namespace}/${target.kind}/${target.pod_name}`, target);
      }

      const normalized = Array.from(combinedMap.values()).sort((a, b) => {
        const aRisk = /crash|fail|pending|error/i.test(a.status) ? 0 : 1;
        const bRisk = /crash|fail|pending|error/i.test(b.status) ? 0 : 1;
        return aRisk - bRisk || a.namespace.localeCompare(b.namespace) || a.pod_name.localeCompare(b.pod_name);
      });

      setTargets(normalized);
      setSelectedTargetId((prev) => {
        if (prev && normalized.some((item) => `${item.namespace}/${item.kind}/${item.pod_name}` === prev)) {
          return prev;
        }
        return normalized.length > 0 ? `${normalized[0].namespace}/${normalized[0].kind}/${normalized[0].pod_name}` : "";
      });
    } catch (error) {
      setTargetError(error instanceof Error ? error.message : String(error));
      setTargets([]);
      setSelectedTargetId("");
    } finally {
      setTargetLoading(false);
    }
  }, [metricsUrl]);

  const fetchInitial = useCallback(async () => {
    try {
      const [statusRes, logsRes] = await Promise.all([
        fetch("/api/ai-agents/healing/status", { cache: "no-store" }),
        fetch("/api/ai-agents/healing/logs", { cache: "no-store" }),
      ]);

      const statusData = (await statusRes.json()) as {
        ok: boolean;
        status: AgentRunnerStatus;
        lifecycle: IssueLifecycle[];
      };
      const logsData = (await logsRes.json()) as {
        ok: boolean;
        logs: StructuredHealingLog[];
      };

      if (statusData.ok) {
        setStatus(statusData.status);
        setLifecycle(statusData.lifecycle || []);
      }
      if (logsData.ok) {
        setLogs(logsData.logs || []);
      }

      const shouldClearCompletedRun =
        statusData.ok &&
        (statusData.status.state === "completed" || statusData.status.state === "failed") &&
        (logsData.logs?.length || 0) > 0;

      if (shouldClearCompletedRun) {
        await fetch("/api/ai-agents/healing/reset", { method: "POST" }).catch(() => undefined);
        setStatus({ state: "idle", totalLogs: 0 });
        setLogs([]);
        setLifecycle([]);
        setSummary(null);
        setSelectedRemediationId("");
      }
    } catch {
      setStartError("Unable to load healing API right now. Ensure the app server is running, then refresh.");
      setStatus((prev) => ({ ...prev, state: "idle", totalLogs: prev.totalLogs || 0 }));
    }
  }, []);

  useEffect(() => {
    void fetchInitial();
    void fetchSummary();
    void fetchTargets();

    const es = new EventSource("/api/ai-agents/healing/stream");
    eventSourceRef.current = es;

    es.addEventListener("init", (evt) => {
      const data = JSON.parse((evt as MessageEvent).data) as {
        status: AgentRunnerStatus;
        logs: StructuredHealingLog[];
        lifecycle: IssueLifecycle[];
      };
      setStatus(data.status);
      setLogs(data.logs || []);
      setLifecycle(data.lifecycle || []);
    });

    es.addEventListener("log", (evt) => {
      const log = JSON.parse((evt as MessageEvent).data) as StructuredHealingLog;
      setLogs((prev) => [...prev, log].slice(-1200));
    });

    es.addEventListener("status", (evt) => {
      const s = JSON.parse((evt as MessageEvent).data) as AgentRunnerStatus;
      setStatus(s);
    });

    es.addEventListener("lifecycle", (evt) => {
      const lc = JSON.parse((evt as MessageEvent).data) as IssueLifecycle[];
      setLifecycle(lc);
    });

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [fetchInitial, fetchSummary, fetchTargets]);

  useEffect(() => {
    const onEndpointChange = () => {
      void fetchTargets();
    };

    window.addEventListener("kubepulse-endpoint", onEndpointChange);
    return () => window.removeEventListener("kubepulse-endpoint", onEndpointChange);
  }, [fetchTargets]);

  useEffect(() => {
    if (status.state === "completed" || status.state === "failed") {
      void fetchSummary();
    }
  }, [status.state, fetchSummary]);

  const startHealing = async () => {
    setStartError("");

    const metricsSourceUrl =
      metricsUrl.trim() || (await readSelectedEndpointFromApi().then((ep) => ep?.ngrok_url || "").catch(() => ""));

    if (!metricsSourceUrl) {
      setStartError("Add a metrics URL or select an endpoint first so the live /pods list can load.");
      return;
    }

    if (!selectedTargetId) {
      setStartError("Select a pod from the live /pods list before starting healing.");
      return;
    }

    const selectedTarget = targets.find((t) => `${t.namespace}/${t.kind}/${t.pod_name}` === selectedTargetId);
    if (!selectedTarget) {
      setStartError("Selected target is no longer available. Refresh the live pod list.");
      return;
    }

    // Always use the live item's kind to avoid pod/deployment mismatch failures.
    const effectiveTargetKind: HealingTargetKind = selectedTarget.kind;
    if (targetKind !== effectiveTargetKind) {
      setTargetKind(effectiveTargetKind);
    }
    const targetName =
      effectiveTargetKind === "deployment"
        ? deploymentNameFromPodName(selectedTarget.pod_name)
        : selectedTarget.pod_name;

    setLoadingStart(true);
    try {
      const res = await fetch("/api/ai-agents/healing/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario,
          dryRun,
          metricsUrl: metricsSourceUrl,
          strictLive: true,
          targetName,
          targetNamespace: selectedTarget.namespace,
          targetKind: effectiveTargetKind,
          remediationPreference: selectedRemediation?.id || null,
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; details?: string };
        setStartError(data.details || data.error || `Failed to start healing (HTTP ${res.status})`);
      }
    } finally {
      setLoadingStart(false);
    }
  };

  const filteredLogs = useMemo(() => {
    let out = [...logs].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

    if (agentFilter !== "all") {
      out = out.filter((l) => l.agent_name === agentFilter);
    }
    if (statusFilter !== "all") {
      out = out.filter((l) => l.status === statusFilter);
    }
    if (timeFilterMinutes !== "all") {
      const mins = Number(timeFilterMinutes);
      if (!Number.isNaN(mins)) {
        const cutoff = Date.now() - mins * 60_000;
        out = out.filter((l) => Date.parse(l.timestamp) >= cutoff);
      }
    }

    return out;
  }, [logs, agentFilter, statusFilter, timeFilterMinutes]);

  const activeAgents = useMemo(() => {
    return Array.from(new Set(logs.map((l) => l.agent_name))).sort();
  }, [logs]);

  const latestReasoningLog = useMemo(() => {
    return [...logs].reverse().find((l) => l.reasoning || typeof l.confidence === "number");
  }, [logs]);

  const llmCallRows = useMemo(() => {
    const rows: LlmCallRow[] = [];

    for (const log of logs) {
      if (log.agent_name !== "GeminiKnowledgeBase") continue;

      const plan = (log.raw as { plan?: unknown } | undefined)?.plan as
        | {
            source?: string;
            assessments?: Array<{
              task?: string;
              service?: string;
              issue?: string;
              decision?: string;
              confidence?: number;
              metadata?: {
                estimated_input_tokens?: number;
                estimated_output_tokens?: number;
                cost_usd?: number;
                model?: string;
              };
            }>;
          }
        | undefined;

      const assessments = Array.isArray(plan?.assessments) ? plan.assessments : [];
      for (let idx = 0; idx < assessments.length; idx += 1) {
        const item = assessments[idx] || {};
        const inputTokens = Number(item.metadata?.estimated_input_tokens || 0);
        const outputTokens = Number(item.metadata?.estimated_output_tokens || 0);
        const costUsd = Number(item.metadata?.cost_usd || 0);

        rows.push({
          key: `${log.id}-${idx}`,
          timestamp: log.timestamp,
          issueId: log.issue_id,
          task: String(item.task || "unknown"),
          service: String(item.service || "unknown"),
          issue: String(item.issue || "unknown"),
          decision: String(item.decision || "observe"),
          confidence: typeof item.confidence === "number" ? item.confidence : null,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          costUsd,
          model: String(item.metadata?.model || "unknown"),
          source: String(plan?.source || "unknown"),
        });
      }
    }

    return rows.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  }, [logs]);

  const llmTotals = useMemo(() => {
    return llmCallRows.reduce(
      (acc, row) => {
        acc.calls += 1;
        acc.inputTokens += row.inputTokens;
        acc.outputTokens += row.outputTokens;
        acc.totalTokens += row.totalTokens;
        acc.costUsd += row.costUsd;
        return acc;
      },
      { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    );
  }, [llmCallRows]);

  const selectedTarget = useMemo(() => {
    return targets.find((t) => `${t.namespace}/${t.kind}/${t.pod_name}` === selectedTargetId) || null;
  }, [targets, selectedTargetId]);

  const hasFailureTargets = useMemo(() => {
    return targets.some((t) => /crash|fail|pending|error|unhealthy|oom|backoff/i.test(t.status));
  }, [targets]);

  const selectedTargetHasFailure = useMemo(() => {
    if (!selectedTarget) return false;
    return /crash|fail|pending|error|unhealthy|oom|backoff/i.test(selectedTarget.status);
  }, [selectedTarget]);

  const shouldShowDecisionOptions =
    selectedTargetHasFailure || hasFailureTargets || status.state === "running";

  const remediationOptions = useMemo<RemediationOption[]>(() => {
    const baseName = selectedTarget?.kind === "deployment" ? "deployment" : "pod";
    const scaleUpScore = scenario === "high-cpu" ? 92 : 84;
    const restartScore = scenario === "pod-crash" ? 89 : 77;
    const dependencyScore = scenario === "service-unavailable" ? 90 : 74;

    return [
      {
        id: "scale-replicas",
        title: `Scale ${baseName} replicas`,
        summary: "Increase replicas so traffic can move to a healthy instance while the bad one is isolated.",
        advantage: ["Best fit when the service needs more capacity", "Keeps the app available while healing"],
        tradeoff: ["Costs extra CPU/memory", "Does not fix the original crash cause directly"],
        score: scaleUpScore,
        estimatedCost: "Moderate resource cost, low disruption",
      },
      {
        id: "restart-workload",
        title: `Restart ${baseName}`,
        summary: "Restart the affected workload so Kubernetes recreates it cleanly.",
        advantage: ["Fastest remediation", "Simple and easy to explain in a demo"],
        tradeoff: ["Brief downtime possible", "May just mask a deeper dependency problem"],
        score: restartScore,
        estimatedCost: "Low cost, short disruption window",
      },
      {
        id: "dependency-first",
        title: "Fix dependency first",
        summary: "Check upstream service, then heal the root dependency before touching the target.",
        advantage: ["Highest chance of fixing the real root cause", "Good for cascading failures"],
        tradeoff: ["Slower than a direct restart", "Needs more investigation time"],
        score: dependencyScore,
        estimatedCost: "Higher analysis cost, lower repeat-failure risk",
      },
    ].sort((a, b) => b.score - a.score);
  }, [scenario, selectedTarget?.kind]);

  const bestRemediation = remediationOptions[0] || null;

  useEffect(() => {
    if (selectedTarget && targetKind !== selectedTarget.kind) {
      setTargetKind(selectedTarget.kind);
    }
  }, [selectedTarget, targetKind]);

  useEffect(() => {
    if (!selectedRemediationId && bestRemediation) {
      setSelectedRemediationId(bestRemediation.id);
    }
  }, [bestRemediation, selectedRemediationId]);

  const selectedRemediation = remediationOptions.find((option) => option.id === selectedRemediationId) || bestRemediation;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">AI Self-Healing Observability</div>
            <div className="text-sm text-muted">
              Live stream of detection, analysis, remediation, and outcome with Gemini-powered summaries.
            </div>
            {startError ? <div className="mt-2 text-sm font-medium text-red-600">{startError}</div> : null}
            {targetError ? <div className="mt-2 text-sm font-medium text-red-600">{targetError}</div> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={metricsUrl}
              onChange={(e) => setMetricsUrl(e.target.value)}
              placeholder="Ngrok metrics URL (optional)"
              className="min-w-[280px] rounded-lg border border-[#dfd4c2] bg-white px-3 py-2 text-sm"
            />
            <select
              value={selectedTargetId}
              onChange={(e) => {
                const next = targets.find((target) => `${target.namespace}/${target.kind}/${target.pod_name}` === e.target.value);
                setSelectedTargetId(e.target.value);
                if (next) {
                  setTargetKind(next.kind);
                }
              }}
              className="min-w-[280px] rounded-lg border border-[#dfd4c2] bg-white px-3 py-2 text-sm"
              disabled={targetLoading || targets.length === 0}
            >
              <option value="">{targetLoading ? "Loading live pod/deployment targets..." : "Select a pod or deployment"}</option>
              {targets.map((target) => (
                <option key={`${target.namespace}/${target.kind}/${target.pod_name}`} value={`${target.namespace}/${target.kind}/${target.pod_name}`}>
                  {target.namespace}/{target.pod_name} · {target.kind} · {target.status}
                </option>
              ))}
            </select>
            <select
              value={targetKind}
              onChange={(e) => setTargetKind(e.target.value as HealingTargetKind)}
              className="rounded-lg border border-[#dfd4c2] bg-white px-3 py-2 text-sm"
            >
              <option value="pod">Pod</option>
              <option value="deployment">Deployment</option>
            </select>
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value as HealingScenario)}
              className="rounded-lg border border-[#dfd4c2] bg-white px-3 py-2 text-sm"
            >
              <option value="pod-crash">Pod crash (CrashLoopBackOff)</option>
              <option value="high-cpu">High CPU usage</option>
              <option value="service-unavailable">Service unavailable</option>
            </select>
            <label className="inline-flex items-center gap-2 rounded-lg border border-[#dfd4c2] bg-white px-3 py-2 text-sm text-[#1f2b33]">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
              />
              Dry run
            </label>
            <button
              onClick={startHealing}
              disabled={loadingStart || status.state === "running"}
              className="inline-flex items-center gap-2 rounded-lg bg-[#1f2b33] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              <PlayCircle className="h-4 w-4" />
              {status.state === "running" ? "Healing Running..." : "Start Healing"}
            </button>
            <button
              onClick={() => void fetchSummary()}
              disabled={loadingSummary}
              className="inline-flex items-center gap-2 rounded-lg border border-[#dfd4c2] bg-white px-3 py-2 text-sm"
            >
              <RefreshCw className={`h-4 w-4 ${loadingSummary ? "animate-spin" : ""}`} />
              Refresh AI Summary
            </button>
          </div>
        </CardHeader>
      </Card>

      {shouldShowDecisionOptions ? (
      <Card>
        <CardHeader className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="text-xl font-bold tracking-tight text-[#1f2b33]">Healing decision options</div>
            <div className="text-sm text-muted">
              Three practical choices are scored here. Pick the one you want, then click Start Healing.
            </div>
          </div>
          <div className="rounded-full bg-[#eef5ea] px-3 py-1 text-xs font-semibold text-[#4f6b3d]">
            Recommended: {bestRemediation?.title || "-"} ({bestRemediation?.score ?? 0}/100)
          </div>
        </CardHeader>
        <CardBody>
          <div className="grid gap-3 lg:grid-cols-3">
            {remediationOptions.map((option, index) => {
              const isSelected = option.id === selectedRemediationId;
              const isBest = option.id === bestRemediation?.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setSelectedRemediationId(option.id)}
                  className={`rounded-2xl border p-4 text-left transition ${
                    isSelected
                      ? "border-[#94b57b] bg-[#f3faec] shadow-sm"
                      : "border-[#e6dbc9] bg-[#fffaf2] hover:border-[#c9b79f]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-muted">Option {index + 1}</div>
                      <div className="mt-1 text-lg font-bold text-[#1f2b33]">{option.title}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-muted">Score</div>
                      <div className="text-2xl font-bold text-[#2f5f45]">{option.score}</div>
                    </div>
                  </div>
                  <div className="mt-3 text-sm text-[#4f5d68]">{option.summary}</div>
                  <div className="mt-3 rounded-xl bg-white/80 p-3 text-xs text-[#4f5d68]">
                    <div className="font-semibold text-[#1f2b33]">Advantages</div>
                    <ul className="mt-1 space-y-1">
                      {option.advantage.map((item) => (
                        <li key={item}>• {item}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="mt-3 text-xs text-[#4f5d68]">
                    <span className="font-semibold text-[#1f2b33]">Tradeoff:</span> {option.tradeoff.join(" ")}
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs">
                    <span className="rounded-full bg-[#f4efe6] px-2 py-1 text-[#5f513f]">{option.estimatedCost}</span>
                    <span
                      className={`rounded-full px-2 py-1 font-semibold ${
                        isBest ? "bg-[#e8f5e8] text-[#3f6a3f]" : "bg-[#f3ece2] text-[#6d5a43]"
                      }`}
                    >
                      {isBest ? "Best score" : isSelected ? "Chosen by SRE" : "Available"}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {selectedRemediation ? (
            <div className="mt-4 rounded-2xl border border-[#d9e7d0] bg-[#f7fbf3] p-4">
              <div className="text-sm font-semibold text-[#2f5f45]">Selected path before heal</div>
              <div className="mt-1 text-sm text-[#4f5d68]">
                {selectedRemediation.title} - {selectedRemediation.summary}
              </div>
              <div className="mt-2 text-xs text-[#5b6872]">
                The score is a guide only. You can still override it with your own judgment before pressing Start Healing.
              </div>
            </div>
          ) : null}
        </CardBody>
      </Card>
      ) : (
        <Card>
          <CardBody>
            <div className="text-sm font-semibold text-[#1f2b33]">Remediation options waiting for failure signal</div>
            <div className="mt-1 text-sm text-muted">
              Options will appear automatically when a pod/deployment shows failure state (CrashLoopBackOff, Failed, Error, Pending) so you can select one, then click Start Healing.
            </div>
          </CardBody>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardBody>
            <div className="text-xs text-muted">Run Status</div>
            <div className={`mt-2 inline-flex rounded-full px-2 py-1 text-xs font-semibold ${statusBadge(status.state)}`}>
              {status.state.toUpperCase()}
            </div>
            <div className="mt-3 text-xs text-muted">Scenario: {status.scenario || scenario}</div>
            <div className="mt-2 text-xs text-muted">
              Target: {status.targetNamespace && status.targetName ? `${status.targetNamespace}/${status.targetName}` : selectedTarget ? `${selectedTarget.namespace}/${selectedTarget.pod_name}` : "-"}
            </div>
            <div className="mt-2 text-xs text-muted">Outcome: </div>
            <div className={`mt-1 inline-flex rounded-full px-2 py-1 text-xs font-semibold ${outcomeBadge(status.outcome)}`}>
              {(status.outcome || "-").toUpperCase()}
            </div>
            <div className="mt-3 text-xs text-muted">
              {status.outcome === "fixed"
                ? "A verified remediation was applied."
                : status.outcome === "no-op"
                  ? "The run completed without applying a fix."
                  : status.outcome === "failed"
                    ? "The run failed before remediation completed."
                    : "Waiting for run outcome."}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="text-xs text-muted">Active Agent</div>
            <div className="mt-2 text-lg font-semibold text-[#1f2b33]">{status.activeAgent || "-"}</div>
            <div className="text-xs text-muted">{status.activeAction || "Waiting for events"}</div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="text-xs text-muted">Issues Tracked</div>
            <div className="mt-2 text-lg font-semibold text-[#1f2b33]">{lifecycle.length}</div>
            <div className="text-xs text-muted">Structured lifecycle records</div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="text-xs text-muted">Total Agent Logs</div>
            <div className="mt-2 text-lg font-semibold text-[#1f2b33]">{status.totalLogs}</div>
            <div className="text-xs text-muted">Real-time SSE stream</div>
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <div className="flex items-center gap-2 text-lg font-semibold text-[#1f2b33]">
              <Activity className="h-5 w-5" />
              Live Agent Timeline
            </div>
            <div className="text-sm text-muted">Chronological event stream from observer, detector, RCA, and executor agents.</div>
          </CardHeader>
          <CardBody>
            <div className="max-h-[360px] space-y-2 overflow-y-auto pr-2">
              {filteredLogs.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#d8cdbb] p-4 text-sm text-muted">
                  No timeline events yet. Start a scenario to stream healing activity.
                </div>
              ) : (
                filteredLogs.map((log) => (
                  <div key={log.id} className="rounded-xl border border-[#e9dece] bg-[#fff8ee] p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-[#5b6872]">{formatTs(log.timestamp)}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${eventBadge(log.event_type)}`}>
                        {log.event_type}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusBadge(log.status)}`}>
                        {log.status}
                      </span>
                      <span className="rounded-full bg-[#f0e5d3] px-2 py-0.5 text-[11px] text-[#4f5d68]">{log.agent_name}</span>
                      <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-[#4f5d68]">{log.issue_id}</span>
                    </div>
                    <div className="mt-2 text-sm font-semibold text-[#1f2b33]">{log.description}</div>
                    <div className="mt-1 text-sm text-[#4f5d68]">Action: {log.action_taken}</div>
                  </div>
                ))
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2 text-lg font-semibold text-[#1f2b33]">
              <BrainCircuit className="h-5 w-5" />
              Agent Activity Panel
            </div>
            <div className="text-sm text-muted">Current activity plus confidence and reasoning context.</div>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="rounded-xl border border-[#e9dece] bg-[#fff8ee] p-3">
              <div className="text-xs text-muted">Active Agent</div>
              <div className="text-base font-semibold text-[#1f2b33]">{status.activeAgent || "-"}</div>
            </div>
            <div className="rounded-xl border border-[#e9dece] bg-[#fff8ee] p-3">
              <div className="text-xs text-muted">Current Action</div>
              <div className="text-sm text-[#1f2b33]">{status.activeAction || "Waiting for next cycle"}</div>
            </div>
            <div className="rounded-xl border border-[#e9dece] bg-[#fff8ee] p-3">
              <div className="text-xs text-muted">Confidence</div>
              <div className="text-base font-semibold text-[#1f2b33]">
                {typeof latestReasoningLog?.confidence === "number" ? `${Math.round(latestReasoningLog.confidence)}%` : "-"}
              </div>
            </div>
            <div className="rounded-xl border border-[#e9dece] bg-[#fff8ee] p-3">
              <div className="text-xs text-muted">Reasoning</div>
              <div className="text-sm text-[#4f5d68]">
                {latestReasoningLog?.reasoning || "Gemini + RCA reasoning will appear here when available."}
              </div>
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2 text-lg font-semibold text-[#1f2b33]">
              <ShieldAlert className="h-5 w-5" />
              Issue Lifecycle Tracker
            </div>
            <div className="text-sm text-muted">Detected, analyzed, fixed, and resolved timestamps for each issue.</div>
          </CardHeader>
          <CardBody>
            <div className="max-h-[320px] overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wider text-muted">
                  <tr>
                    <th className="py-2">Issue</th>
                    <th className="py-2">Detected</th>
                    <th className="py-2">Analyzed</th>
                    <th className="py-2">Fixed</th>
                    <th className="py-2">Resolved</th>
                  </tr>
                </thead>
                <tbody>
                  {lifecycle.length === 0 ? (
                    <tr>
                      <td className="py-3 text-muted" colSpan={5}>No issue lifecycle records yet.</td>
                    </tr>
                  ) : (
                    lifecycle.map((issue) => (
                      <tr key={issue.issue_id} className="border-t border-[#efe4d5] align-top">
                        <td className="py-2">
                          <div className="font-medium text-[#1f2b33]">{issue.issue_id}</div>
                          <div className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] ${statusBadge(issue.status)}`}>
                            {issue.status}
                          </div>
                        </td>
                        <td className="py-2 text-xs text-[#4f5d68]">{formatTs(issue.detected_at)}</td>
                        <td className="py-2 text-xs text-[#4f5d68]">{formatTs(issue.analysis_started_at)}</td>
                        <td className="py-2 text-xs text-[#4f5d68]">{formatTs(issue.fix_applied_at)}</td>
                        <td className="py-2 text-xs text-[#4f5d68]">{formatTs(issue.resolved_at || issue.failed_at)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2 text-lg font-semibold text-[#1f2b33]">
              <BrainCircuit className="h-5 w-5" />
              AI Summary Panel (Gemini)
            </div>
            <div className="text-sm text-muted">What happened, actions taken, final outcome, and decision trace.</div>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="rounded-xl border border-[#e9dece] bg-[#fff8ee] p-3">
              <div className="text-xs text-muted">What happened</div>
              <div className="text-sm text-[#1f2b33]">{summary?.what_happened || "No summary available yet."}</div>
            </div>
            <div className="rounded-xl border border-[#e9dece] bg-[#fff8ee] p-3">
              <div className="text-xs text-muted">Actions taken</div>
              <div className="text-sm text-[#1f2b33]">{summary?.actions_taken || "-"}</div>
            </div>
            <div className="rounded-xl border border-[#e9dece] bg-[#fff8ee] p-3">
              <div className="text-xs text-muted">Final outcome</div>
              <div className="text-sm text-[#1f2b33]">{summary?.final_outcome || "-"}</div>
            </div>
            <div className="rounded-xl border border-[#e9dece] bg-[#fff8ee] p-3">
              <div className="text-xs text-muted">Decision trace</div>
              <div className="text-sm text-[#1f2b33]">{summary?.decision_trace || "-"}</div>
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 text-lg font-semibold text-[#1f2b33]">
            <BrainCircuit className="h-5 w-5" />
            LLM Token + Cost Telemetry
          </div>
          <div className="text-sm text-muted">
            Real-time Gemini call accounting captured during self-heal runs.
          </div>
        </CardHeader>
        <CardBody>
          <div className="mb-3 grid gap-2 md:grid-cols-5">
            <div className="rounded-lg border border-[#e7ddcd] bg-[#fff8ee] px-3 py-2 text-sm">
              <div className="text-xs text-muted">Calls</div>
              <div className="font-semibold text-[#1f2b33]">{llmTotals.calls}</div>
            </div>
            <div className="rounded-lg border border-[#e7ddcd] bg-[#fff8ee] px-3 py-2 text-sm">
              <div className="text-xs text-muted">Input tokens</div>
              <div className="font-semibold text-[#1f2b33]">{llmTotals.inputTokens}</div>
            </div>
            <div className="rounded-lg border border-[#e7ddcd] bg-[#fff8ee] px-3 py-2 text-sm">
              <div className="text-xs text-muted">Output tokens</div>
              <div className="font-semibold text-[#1f2b33]">{llmTotals.outputTokens}</div>
            </div>
            <div className="rounded-lg border border-[#e7ddcd] bg-[#fff8ee] px-3 py-2 text-sm">
              <div className="text-xs text-muted">Total tokens</div>
              <div className="font-semibold text-[#1f2b33]">{llmTotals.totalTokens}</div>
            </div>
            <div className="rounded-lg border border-[#e7ddcd] bg-[#fff8ee] px-3 py-2 text-sm">
              <div className="text-xs text-muted">Estimated cost (USD)</div>
              <div className="font-semibold text-[#1f2b33]">${llmTotals.costUsd.toFixed(6)}</div>
            </div>
          </div>

          <div className="max-h-[320px] overflow-auto rounded-xl border border-[#e9dece] bg-[#fff8ee]">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-[#f6edde] text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Task</th>
                  <th className="px-3 py-2">Service</th>
                  <th className="px-3 py-2">Decision</th>
                  <th className="px-3 py-2">Confidence</th>
                  <th className="px-3 py-2">Input</th>
                  <th className="px-3 py-2">Output</th>
                  <th className="px-3 py-2">Total</th>
                  <th className="px-3 py-2">Cost</th>
                  <th className="px-3 py-2">Model</th>
                </tr>
              </thead>
              <tbody>
                {llmCallRows.length === 0 ? (
                  <tr>
                    <td className="px-3 py-3 text-muted" colSpan={10}>
                      No LLM calls captured yet. Click Start Healing to populate this table in real time.
                    </td>
                  </tr>
                ) : (
                  llmCallRows.map((row) => (
                    <tr key={row.key} className="border-t border-[#efe4d5] align-top">
                      <td className="px-3 py-2 text-xs text-[#4f5d68]">{formatTs(row.timestamp)}</td>
                      <td className="px-3 py-2">{row.task}</td>
                      <td className="px-3 py-2 text-[#4f5d68]">{row.service}</td>
                      <td className="px-3 py-2 text-[#1f2b33]">{row.decision}</td>
                      <td className="px-3 py-2 text-[#4f5d68]">
                        {typeof row.confidence === "number" ? `${Math.round(row.confidence * 100)}%` : "-"}
                      </td>
                      <td className="px-3 py-2 text-[#4f5d68]">{row.inputTokens}</td>
                      <td className="px-3 py-2 text-[#4f5d68]">{row.outputTokens}</td>
                      <td className="px-3 py-2 text-[#4f5d68]">{row.totalTokens}</td>
                      <td className="px-3 py-2 text-[#1f2b33]">${row.costUsd.toFixed(6)}</td>
                      <td className="px-3 py-2 text-xs text-[#4f5d68]">{row.model}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 text-lg font-semibold text-[#1f2b33]">
            <Wrench className="h-5 w-5" />
            Logs Viewer
          </div>
          <div className="text-sm text-muted">Structured logs with filters by agent, status, and recent time window.</div>
        </CardHeader>
        <CardBody>
          <div className="mb-3 grid gap-2 md:grid-cols-4">
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="rounded-lg border border-[#dfd4c2] bg-white px-3 py-2 text-sm"
            >
              <option value="all">All agents</option>
              {activeAgents.map((agent) => (
                <option key={agent} value={agent}>{agent}</option>
              ))}
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-lg border border-[#dfd4c2] bg-white px-3 py-2 text-sm"
            >
              <option value="all">All statuses</option>
              <option value="OPEN">OPEN</option>
              <option value="IN_PROGRESS">IN_PROGRESS</option>
              <option value="SUCCESS">SUCCESS</option>
              <option value="FAILED">FAILED</option>
            </select>

            <select
              value={timeFilterMinutes}
              onChange={(e) => setTimeFilterMinutes(e.target.value)}
              className="rounded-lg border border-[#dfd4c2] bg-white px-3 py-2 text-sm"
            >
              <option value="all">All time</option>
              <option value="5">Last 5 minutes</option>
              <option value="15">Last 15 minutes</option>
              <option value="60">Last 60 minutes</option>
            </select>

            <div className="rounded-lg border border-[#dfd4c2] bg-white px-3 py-2 text-sm text-muted">
              Showing {filteredLogs.length} / {logs.length} log entries
            </div>
          </div>

          <div className="max-h-[380px] overflow-auto rounded-xl border border-[#e9dece] bg-[#fff8ee]">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-[#f6edde] text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Agent</th>
                  <th className="px-3 py-2">Event</th>
                  <th className="px-3 py-2">Issue</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.length === 0 ? (
                  <tr>
                    <td className="px-3 py-3 text-muted" colSpan={7}>No logs match current filters.</td>
                  </tr>
                ) : (
                  filteredLogs.map((log) => (
                    <tr key={log.id} className="border-t border-[#efe4d5] align-top">
                      <td className="px-3 py-2 text-xs text-[#4f5d68]">{formatTs(log.timestamp)}</td>
                      <td className="px-3 py-2">{log.agent_name}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${eventBadge(log.event_type)}`}>
                          {log.event_type}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-[#4f5d68]">{log.issue_id}</td>
                      <td className="px-3 py-2 text-[#1f2b33]">{log.description}</td>
                      <td className="px-3 py-2 text-[#4f5d68]">{log.action_taken}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusBadge(log.status)}`}>
                          {log.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
