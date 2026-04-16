import { NextResponse } from "next/server";
import { DependencyGraphEngine } from "@/lib/dependency-engine";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Engine singleton
let engineInstance: InstanceType<typeof DependencyGraphEngine> | null = null;

function getEngine() {
  if (!engineInstance) {
    engineInstance = new DependencyGraphEngine();
  }
  return engineInstance;
}

export async function POST(request: Request) {
  try {
    const { pod_id, pod_name, reason, endpoint_id } = await request.json();

    if (!pod_id && !pod_name) {
      return NextResponse.json(
        { error: "Missing pod_id or pod_name", ok: false },
        { status: 400 }
      );
    }

    const engine = getEngine();
    const targetPod = pod_id || pod_name;

    // Report failure to engine
    const result = engine.reportFailure(targetPod, reason || "Failure detected");

    // Log the failure event
    engine.logEvent("failure_reported", {
      pod: targetPod,
      reason,
      analysis: {
        rootCause: result.analysis?.rootCause,
        confidence: result.analysis?.confidence,
        affected: result.impact?.affectedPods?.length || 0,
      },
    });

    // Create database records
    const supabase = await createSupabaseServerClient();

    // Create alert
    await supabase.from("alerts").insert({
      endpoint_id,
      pod_name: targetPod,
      message: `RCA Analysis: Root cause identified as ${result.analysis?.rootCause} (${Math.round(
        (result.analysis?.confidence || 0) * 100
      )}% confidence)`,
      severity: result.impact?.severity === "CRITICAL" ? "high" : "medium",
      resolved: false,
    });

    // Log remediation suggestions as events
    if (result.analysis?.remediation) {
      for (const rem of result.analysis.remediation) {
        await supabase.from("events").insert({
          endpoint_id,
          event_type: "remediation_suggested",
          title: rem.action,
          description: rem.reason,
          details: JSON.stringify(rem),
        });
      }
    }

    return NextResponse.json(
      {
        ok: true,
        result: {
          rootCause: result.analysis?.rootCause,
          confidence: result.analysis?.confidence,
          affectedPods: result.impact?.affectedPods,
          severity: result.impact?.severity,
          remediation: result.analysis?.remediation,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Failure report error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to report failure",
        ok: false,
      },
      { status: 500 }
    );
  }
}
