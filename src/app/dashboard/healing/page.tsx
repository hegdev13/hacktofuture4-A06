"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, BrainCircuit, PlayCircle, RefreshCw, ShieldAlert, Wrench } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

type HealingEventType = "DETECTED" | "ANALYZING" | "FIXING" | "RESOLVED" | "FAILED";
type HealingLogStatus = "OPEN" | "IN_PROGRESS" | "SUCCESS" | "FAILED";
type HealingScenario = "pod-crash" | "high-cpu" | "service-unavailable";

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
  startedAt?: string;
  finishedAt?: string;
  activeAgent?: string;
  activeAction?: string;
  activeIssueId?: string;
  scenario?: HealingScenario;
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

function eventBadge(eventType: HealingEventType) {
  if (eventType === "DETECTED") return "bg-red-100 text-red-700";
  if (eventType === "ANALYZING") return "bg-blue-100 text-blue-700";
  if (eventType === "FIXING") return "bg-amber-100 text-amber-700";
  if (eventType === "RESOLVED") return "bg-emerald-100 text-emerald-700";
  return "bg-slate-100 text-slate-700";
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
  const eventSourceRef = useRef<EventSource | null>(null);

  const fetchSummary = useCallback(async () => {
    setLoadingSummary(true);
    try {
      const res = await fetch("/api/ai-agents/healing/summary", { cache: "no-store" });
      const data = (await res.json()) as { ok: boolean; summary?: HealingSummary };
      if (res.ok && data.ok && data.summary) {
        setSummary(data.summary);
      }
    } finally {
      setLoadingSummary(false);
    }
  }, []);

  const fetchInitial = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    void fetchInitial();
    void fetchSummary();

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
  }, [fetchInitial, fetchSummary]);

  useEffect(() => {
    if (status.state === "completed" || status.state === "failed") {
      void fetchSummary();
    }
  }, [status.state, fetchSummary]);

  const startHealing = async () => {
    setLoadingStart(true);
    try {
      await fetch("/api/ai-agents/healing/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario,
          dryRun,
          metricsUrl: metricsUrl.trim() || undefined,
        }),
      });
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

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">AI Self-Healing Observability</div>
            <div className="text-sm text-muted">
              Live stream of detection, analysis, remediation, and outcome with Gemini-powered summaries.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={metricsUrl}
              onChange={(e) => setMetricsUrl(e.target.value)}
              placeholder="Ngrok metrics URL (optional)"
              className="min-w-[280px] rounded-lg border border-[#dfd4c2] bg-white px-3 py-2 text-sm"
            />
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

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardBody>
            <div className="text-xs text-muted">Run Status</div>
            <div className={`mt-2 inline-flex rounded-full px-2 py-1 text-xs font-semibold ${statusBadge(status.state)}`}>
              {status.state.toUpperCase()}
            </div>
            <div className="mt-3 text-xs text-muted">Scenario: {status.scenario || scenario}</div>
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
