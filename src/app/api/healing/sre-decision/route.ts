import { NextResponse } from "next/server";
import {
  submitSREDecision,
  getPendingDecision,
  getAllPendingDecisions,
} from "@/ai-agents/healingOrchestrator";
import { healingRunnerService } from "@/lib/healing/agent-runner";
import { resumeAfterSREDecision } from "@/ai-agents/agentService";

export const runtime = "nodejs";

/**
 * GET: Get pending SRE decisions
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const issueId = searchParams.get("issue_id");

    if (issueId) {
      const pending = getPendingDecision(issueId);
      if (!pending) {
        return NextResponse.json(
          { ok: false, error: "No pending decision found" },
          { status: 404 }
        );
      }
      return NextResponse.json({
        ok: true,
        data: {
          issueId,
          ...pending,
        },
      });
    }

    // Return all pending decisions
    const allPending = getAllPendingDecisions();
    return NextResponse.json({
      ok: true,
      data: allPending,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}

/**
 * POST: Submit SRE decision
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      issue_id,
      selected_option_id,
      selection_reason,
      sre_user = "sre",
    } = body;

    if (!issue_id || !selected_option_id) {
      return NextResponse.json(
        { ok: false, error: "Missing required fields: issue_id, selected_option_id" },
        { status: 400 }
      );
    }

    // Check if there's a pending decision
    const pending = getPendingDecision(issue_id);
    if (!pending) {
      // Check if the issue is already being processed
      const status = healingRunnerService.getAgentStatus();
      if (status.activeIssueId === issue_id && status.state === "running") {
        return NextResponse.json(
          { ok: false, error: "Issue is already being processed" },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { ok: false, error: "No pending decision found for this issue" },
        { status: 404 }
      );
    }

    // Update runner state
    resumeAfterSREDecision(issue_id, selected_option_id, selection_reason);

    // Submit the decision and execute
    const result = await submitSREDecision(
      issue_id,
      selected_option_id,
      selection_reason,
      sre_user
    );

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      message: "SRE decision submitted successfully",
      data: {
        issue_id,
        selected_option: selected_option_id,
        selection_reason,
        execution: result.data,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
