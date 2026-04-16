import { NextRequest, NextResponse } from "next/server";

// CommonJS module exported by the self-healing system.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const observer = require("../../../../ai-agents/self-healing-system/agents/observer");

type PodMetricLike = {
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
};

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function normalizePod(pod: PodMetricLike) {
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
  };
}

function metricsToClusterState(metricsData: any) {
  return {
    pods: (metricsData?.pods || []).map((p: PodMetricLike) => normalizePod(p)),
    nodes: metricsData?.nodes || [],
    services: metricsData?.services || [],
    metrics: metricsData?.metrics || { cluster: metricsData?.cluster || {} },
    timestamp: metricsData?.timestamp || new Date().toISOString(),
  };
}

function shapeObserverResponse(analysis: any) {
  const decision = analysis?.rcaDecision || {};
  return {
    triggerRCA: Boolean(decision.triggerRCA),
    reason: String(decision.reason || "No decision available"),
    metricsSummary: decision.metricsSummary || {},
    issuesSummary: analysis?.summary || {},
    issueCount: Array.isArray(analysis?.issues) ? analysis.issues.length : 0,
    healthy: Boolean(analysis?.healthy),
    timestamp: analysis?.timestamp || new Date().toISOString(),
  };
}

function maybeLogDecision(source: "GET" | "POST", payload: any, debug: boolean) {
  if (!debug) return;
  console.log("[OBSERVER][VERIFY] source=%s triggerRCA=%s", source, payload.triggerRCA);
  console.log("[OBSERVER][VERIFY][JSON] %s", JSON.stringify(payload, null, 2));
}

export async function GET(request: NextRequest) {
  try {
    const debug = request.nextUrl.searchParams.get("debug") === "1";
    const metricsUrl =
      process.env.OBSERVER_METRICS_URL ||
      process.env.METRICS_URL ||
      "http://localhost:5555/api/metrics";

    const response = await fetch(metricsUrl, { cache: "no-store" });
    if (!response.ok) {
      return NextResponse.json(
        {
          triggerRCA: false,
          reason: `Unable to fetch metrics from ${metricsUrl} (${response.status})`,
          metricsSummary: {},
        },
        { status: 502 }
      );
    }

    const metricsData = await response.json();
    const clusterState = metricsToClusterState(metricsData);
    const analysis = observer.analyzeClusterState(clusterState);
    const payload = shapeObserverResponse(analysis);

    maybeLogDecision("GET", payload, debug);
    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    console.error("[OBSERVER][VERIFY][ERROR][GET]", error);
    return NextResponse.json(
      {
        triggerRCA: false,
        reason: error instanceof Error ? error.message : "Observer verification failed",
        metricsSummary: {},
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const debug = request.nextUrl.searchParams.get("debug") === "1";
    const body = await request.json();

    // Accept either raw clusterState or metrics-like payload.
    const clusterState = body?.pods || body?.services || body?.nodes
      ? {
          pods: body.pods || [],
          nodes: body.nodes || [],
          services: body.services || [],
          metrics: body.metrics || {},
          timestamp: body.timestamp || new Date().toISOString(),
        }
      : metricsToClusterState(body);

    const analysis = observer.analyzeClusterState(clusterState);
    const payload = shapeObserverResponse(analysis);

    maybeLogDecision("POST", payload, debug);
    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    console.error("[OBSERVER][VERIFY][ERROR][POST]", error);
    return NextResponse.json(
      {
        triggerRCA: false,
        reason: error instanceof Error ? error.message : "Observer verification failed",
        metricsSummary: {},
      },
      { status: 500 }
    );
  }
}
