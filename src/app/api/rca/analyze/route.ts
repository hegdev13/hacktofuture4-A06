import { NextRequest, NextResponse } from "next/server";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const observer = require("../../../../ai-agents/self-healing-system/agents/observer");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rca = require("../../../../ai-agents/self-healing-system/agents/rca");

type PodLike = {
  name?: string;
  namespace?: string;
  status?: string;
  phase?: string;
  cpu?: number;
  cpuUsage?: number;
  memory?: number;
  memoryUsage?: number;
  restarts?: number;
  restartCount?: number;
  errorRate?: number;
  logs?: unknown;
  events?: unknown;
  dependencies?: unknown;
};

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function normalizePod(pod: PodLike) {
  return {
    name: String(pod.name || "unknown"),
    namespace: String(pod.namespace || "default"),
    status: String(pod.status || pod.phase || "unknown"),
    cpu: Number(pod.cpu ?? pod.cpuUsage ?? 0),
    memory: Number(pod.memory ?? pod.memoryUsage ?? 0),
    restarts: Number(pod.restarts ?? pod.restartCount ?? 0),
    errorRate: Number(pod.errorRate ?? 0),
    logs: toArray(pod.logs),
    events: toArray(pod.events),
    dependencies: Array.isArray(pod.dependencies) ? pod.dependencies : [],
  };
}

function normalizeClusterState(input: any) {
  return {
    pods: (input?.pods || []).map((p: PodLike) => normalizePod(p)),
    services: Array.isArray(input?.services) ? input.services : [],
    nodes: Array.isArray(input?.nodes) ? input.nodes : [],
    metrics: input?.metrics || {},
    timestamp: input?.timestamp || new Date().toISOString(),
  };
}

function analysisToDetectedIssues(analysis: any) {
  const issues = Array.isArray(analysis?.issues) ? analysis.issues : [];
  return issues.map((issue: any) => ({
    target: issue.target || issue.pod || issue.node,
    problem: issue.problem,
    severity: issue.severity,
    metric: issue.metric,
    details: issue.details,
    isFlapping: issue.isFlapping,
  }));
}

function buildLifecyclePayload(clusterState: any) {
  const analysis = observer.analyzeClusterState(clusterState);
  const detectedIssues = analysisToDetectedIssues(analysis);
  const rcaOutput = rca.performRCA(clusterState, detectedIssues);
  const activeIssue = (rcaOutput.issues || []).find((issue: any) => issue.status === "ACTIVE") || null;

  return {
    observer: {
      triggerRCA: Boolean(analysis?.rcaDecision?.triggerRCA),
      reason: String(analysis?.rcaDecision?.reason || "No decision available"),
      metricsSummary: analysis?.rcaDecision?.metricsSummary || {},
      issueCount: Array.isArray(analysis?.issues) ? analysis.issues.length : 0,
    },
    rca: {
      action: rcaOutput.action || "NO_ACTION",
      issues: Array.isArray(rcaOutput.issues) ? rcaOutput.issues : [],
      rootCause: activeIssue?.rootCause || rcaOutput.rootCause || null,
      failureChain: activeIssue?.failureChain || rcaOutput.failureChain || [],
      confidence: activeIssue?.confidence ?? rcaOutput.confidenceScore ?? 0,
      reasoning: activeIssue?.reasoning || rcaOutput.reasoning || "No RCA reasoning available",
      chainDetails: rcaOutput.chainDetails || [],
      reportPath: rcaOutput.reportPath || null,
      executor: {
        rootCause: activeIssue?.rootCause || rcaOutput.rootCause || null,
        confidence: typeof rcaOutput.confidence === "number" ? rcaOutput.confidence : 0,
        failureChain: activeIssue?.failureChain || rcaOutput.failureChain || [],
        chainDetails: rcaOutput.chainDetails || [],
      },
    },
    timestamp: new Date().toISOString(),
  };
}

async function fetchMetricsState() {
  const metricsUrl = process.env.RCA_METRICS_URL || process.env.METRICS_URL || "http://localhost:5555/api/metrics";
  const response = await fetch(metricsUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to fetch metrics from ${metricsUrl} (${response.status})`);
  }
  const body = await response.json();
  return normalizeClusterState(body);
}

export async function GET() {
  try {
    const clusterState = await fetchMetricsState();
    const payload = buildLifecyclePayload(clusterState);
    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    console.error("[RCA][ANALYZE][GET][ERROR]", error);
    return NextResponse.json(
      {
        observer: {
          triggerRCA: false,
          reason: error instanceof Error ? error.message : "RCA analyze failed",
          metricsSummary: {},
          issueCount: 0,
        },
        rca: {
          action: "NO_ACTION",
          issues: [],
          rootCause: null,
          failureChain: [],
          confidence: 0,
          reasoning: "RCA analyze failed",
          chainDetails: [],
          reportPath: null,
          executor: {
            rootCause: null,
            confidence: 0,
            failureChain: [],
            chainDetails: [],
          },
        },
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const clusterState = normalizeClusterState(body);
    const payload = buildLifecyclePayload(clusterState);
    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    console.error("[RCA][ANALYZE][POST][ERROR]", error);
    return NextResponse.json(
      {
        observer: {
          triggerRCA: false,
          reason: error instanceof Error ? error.message : "RCA analyze failed",
          metricsSummary: {},
          issueCount: 0,
        },
        rca: {
          action: "NO_ACTION",
          issues: [],
          rootCause: null,
          failureChain: [],
          confidence: 0,
          reasoning: "RCA analyze failed",
          chainDetails: [],
          reportPath: null,
          executor: {
            rootCause: null,
            confidence: 0,
            failureChain: [],
            chainDetails: [],
          },
        },
      },
      { status: 500 }
    );
  }
}
