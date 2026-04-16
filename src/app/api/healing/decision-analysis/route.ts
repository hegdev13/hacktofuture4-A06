import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      issue_id,
      root_cause,
      options,
      selected_option,
      selection_reason,
      affected_resources_count,
    } = body;

    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json(
        { ok: false, error: "Supabase not configured" },
        { status: 500 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Store decision analysis in observability_events or create new table
    const { error } = await supabase
      .from("observability_events")
      .insert({
        agent_name: "DecisionAnalyzer",
        event_type: "REMEDIATION_OPTIONS",
        issue_id,
        description: `Decision analysis: ${selection_reason}`,
        action_taken: `Selected ${selected_option}`,
        status: "COMPLETED",
        raw: {
          root_cause,
          options,
          selected_option,
          selection_reason,
          affected_resources_count,
        },
      });

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      message: "Decision analysis recorded",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const issueId = searchParams.get("issue_id");

    if (!issueId || !supabaseUrl || !supabaseKey) {
      return NextResponse.json(
        { ok: false, error: "Missing issue_id or Supabase not configured" },
        { status: 400 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error } = await supabase
      .from("observability_events")
      .select("*")
      .eq("issue_id", issueId)
      .eq("event_type", "REMEDIATION_OPTIONS")
      .single();

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      data,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
