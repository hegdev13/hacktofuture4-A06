import { NextResponse } from "next/server";
import { buildDependencyImpact } from "@/lib/observability/dependency";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function pickFirstDefined(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function normalizeStatus(status: string): "running" | "failed" | "pending" {
  const s = status.toLowerCase().trim();
  if (
    s.includes("running") ||
    s.includes("healthy") ||
    s.includes("ready") ||
    s.includes("succeeded") ||
    s === "ok"
  ) {
    return "running";
  }
  if (s.includes("pending") || s.includes("init") || s.includes("waiting")) return "pending";
  return "failed";
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const endpointId = searchParams.get("endpoint");

    if (!endpointId) {
      return NextResponse.json(
        { error: "Missing endpoint parameter", ok: false },
        { status: 400 }
      );
    }

    const supabase = await createSupabaseServerClient();

    // Fetch latest pod metrics
    const { data: metricsData, error: metricsError } = await supabase
      .from("metrics_snapshots")
      .select("*")
      .eq("endpoint_id", endpointId)
      .order("timestamp", { ascending: false })
      .limit(200);

    if (metricsError) throw metricsError;

    // Get latest snapshot for each pod
    const latestByPod = new Map<string, any>();
    for (const metric of metricsData || []) {
      const key = `${metric.namespace || "default"}/${metric.pod_name}`;
      if (!latestByPod.has(key)) {
        latestByPod.set(key, metric);
      }
    }

    // Build auxiliary dependency evidence maps from raw rows.
    const logsByService: Record<string, string[]> = {};
    const configsByService: Record<string, unknown> = {};

    const serviceFromPodName = (podName: string) =>
      podName
        .toLowerCase()
        .replace(/-[a-f0-9]{8,10}-[a-z0-9]{5}$/i, "")
        .replace(/-\d+$/, "");

    for (const row of metricsData || []) {
      const metric = row as Record<string, unknown>;
      const podName = String(metric.pod_name || "unknown");
      const service = serviceFromPodName(podName);

      const logValue = pickFirstDefined(metric, [
        "logs",
        "log",
        "log_line",
        "log_message",
        "message",
      ]);

      if (logValue !== undefined) {
        const parsedLog = parseMaybeJson(logValue);
        if (!logsByService[service]) logsByService[service] = [];
        if (typeof parsedLog === "string") {
          logsByService[service].push(parsedLog);
        } else if (Array.isArray(parsedLog)) {
          for (const item of parsedLog) {
            logsByService[service].push(String(item));
          }
        }
      }

      if (!configsByService[service]) {
        const configValue = pickFirstDefined(metric, [
          "config",
          "config_data",
          "settings",
          "config_map",
          "secret_data",
        ]);
        if (configValue !== undefined) {
          configsByService[service] = parseMaybeJson(configValue);
        }
      }
    }

    // Build snapshot for dependency analysis
    const snapshot = {
      fetched_at: new Date().toISOString(),
      pods: Array.from(latestByPod.values()).map((metric: any) => ({
        pod_name: metric.pod_name,
        namespace: metric.namespace || "default",
        status: normalizeStatus(metric.status),
        cpu_usage: parseFloat(metric.cpu_usage || metric.cpu || "0"),
        memory_usage: parseFloat(metric.memory_usage || metric.memory || "0"),
        restart_count: parseInt(metric.restart_count || "0"),
        error_rate: parseFloat(metric.error_rate || "0"),
        labels: metric.labels ? (typeof metric.labels === "string" ? JSON.parse(metric.labels) : metric.labels) : {},
        spec: parseMaybeJson(pickFirstDefined(metric, ["spec", "pod_spec"])),
        env: parseMaybeJson(pickFirstDefined(metric, ["env", "environment"])),
        envVars: parseMaybeJson(pickFirstDefined(metric, ["env_vars", "envVars"])),
      })),
      configs: configsByService,
      logs: logsByService,
    };

    // Use dependency graph to build visualization
    const impact = buildDependencyImpact(snapshot);

    // Calculate health
    const failedCount = impact.graphPods.filter(p => p.status === "failed").length;
    const totalCount = impact.graphPods.length;
    
    let clusterStatus: "healthy" | "degraded" | "critical" = "healthy";
    if (failedCount > 0) {
      clusterStatus = failedCount > (totalCount / 2) ? "critical" : "degraded";
    }

    return NextResponse.json({
      ok: true,
      analysis: {
        graphPods: impact.graphPods,
        status: clusterStatus,
        healthPercent: impact.healthPercent,
        summary: impact.summary,
      },
    });
  } catch (error) {
    console.error("Dependency graph error:", error);
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Graph analysis failed",
        ok: false 
      },
      { status: 500 }
    );
  }
}
