import { NextRequest, NextResponse } from "next/server";

/**
 * Metrics Context Endpoint for ElevenLabs Agent
 * 
 * The agent can call this endpoint to get current cluster metrics context
 * Usage: GET /api/metrics/context
 */
export async function GET(request: NextRequest) {
  try {
    const metricsUrl = process.env.NEXT_PUBLIC_METRICS_URL || "http://localhost:5555/api/metrics";

    // Fetch metrics from the backend
    const response = await fetch(metricsUrl, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch metrics: ${response.status}`);
    }

    const metrics = await response.json();

    // Format metrics for the agent in a clear, digestible way
    const contextSummary = {
      cluster_status: metrics.cluster.status,
      cluster_name: metrics.cluster.name,
      total_nodes: metrics.cluster.nodes,
      total_pods: metrics.cluster.pods_total,
      running_pods: metrics.cluster.pods_running,
      failed_pods: metrics.cluster.pods_failed,
      cpu_usage: `${metrics.resources.cpu_usage_percent}%`,
      memory_usage: `${metrics.resources.memory_usage_percent}%`,
      storage_usage: `${metrics.resources.storage_usage_percent}%`,
      timestamp: new Date().toISOString(),
      alerts_count: metrics.alerts?.length || 0,
      alerts: metrics.alerts?.slice(0, 3).map((a: any) => ({
        severity: a.severity,
        message: a.message,
      })) || [],
    };

    console.log("✅ Agent metrics context provided:", {
      cluster: contextSummary.cluster_name,
      status: contextSummary.cluster_status,
      cpu: contextSummary.cpu_usage,
      memory: contextSummary.memory_usage,
    });

    return NextResponse.json(contextSummary, {
      status: 200,
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("❌ Error providing metrics context:", error);

    return NextResponse.json(
      {
        error: "Failed to fetch metrics context",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
