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
    const { pod_id, pod_name, endpoint_id } = await request.json();

    if (!pod_id && !pod_name) {
      return NextResponse.json(
        { error: "Missing pod_id or pod_name", ok: false },
        { status: 400 }
      );
    }

    const engine = getEngine();
    const targetPod = pod_id || pod_name;

    // Report healing to engine
    const result = engine.reportHealing(targetPod);

    // Log the healing event
    engine.logEvent("healing_reported", {
      pod: targetPod,
      analysis: {
        recovered: result.recovered,
        restoredPods: result.restoredServices?.length || 0,
        systemHealth: result.systemHealth,
      },
    });

    // Update database
    const supabase = await createSupabaseServerClient();

    // Mark related alerts as resolved
    await supabase
      .from("alerts")
      .update({ resolved: true })
      .eq("pod_name", targetPod)
      .eq("endpoint_id", endpoint_id);

    // Create recovery event
    await supabase.from("events").insert({
      endpoint_id,
      event_type: "pod_recovered",
      title: `${targetPod} recovered`,
      description: `Pod has been healed and restored to healthy state. System health: ${(
        result.systemHealth * 100
      ).toFixed(1)}%`,
      details: JSON.stringify({
        recovered: result.recovered,
        restoredServices: result.restoredServices,
        systemHealth: result.systemHealth,
      }),
    });

    // Broadcast recovery event for real-time dashboard updates
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("pod-healed", {
          detail: { podName: targetPod, systemHealth: result.systemHealth },
        })
      );
    }

    return NextResponse.json(
      {
        ok: true,
        result: {
          recovered: result.recovered,
          restoredServices: result.restoredServices,
          systemHealth: result.systemHealth,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Healing report error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to report healing",
        ok: false,
      },
      { status: 500 }
    );
  }
}
