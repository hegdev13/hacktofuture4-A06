import { NextResponse } from "next/server";
import { getPendingValidation } from "@/ai-agents/healingOrchestrator";

export const runtime = "nodejs";

/**
 * GET /api/healing/sre-validation/{issueId}
 * Get pending SRE validation for a specific issue
 */
export async function GET(
  request: Request,
  { params }: { params: { issueId: string } }
) {
  try {
    const { issueId } = params;
    const pending = getPendingValidation(issueId);

    if (!pending) {
      return NextResponse.json(
        {
          ok: false,
          error: "No pending validation found",
          issueId,
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      data: {
        issueId,
        status: pending.status,
        createdAt: pending.createdAt,
        selectedOption: {
          id: pending.selectedOption?.id,
          name: pending.selectedOption?.name,
          description: pending.selectedOption?.description,
        },
        executionResult: pending.executionResult,
        checkpointAvailable: pending.checkpointAvailable,
        actions: pending.checkpointAvailable
          ? {
              accept: {
                method: "POST",
                url: `/api/healing/sre-validation/${issueId}/accept`,
                description: "Accept execution results and finalize",
              },
              reject: {
                method: "POST",
                url: `/api/healing/sre-validation/${issueId}/reject`,
                description: "Reject execution and rollback to checkpoint",
              },
            }
          : {
              accept: {
                method: "POST",
                url: `/api/healing/sre-validation/${issueId}/accept`,
                description: "Accept execution results",
              },
            },
      },
    });
  } catch (error) {
    console.error("Error fetching SRE validation:", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to fetch validation",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
