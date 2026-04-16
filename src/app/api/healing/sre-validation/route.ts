import { NextResponse } from "next/server";
import {
  submitSREAcceptance,
  submitSRERejection,
  getPendingValidation,
  getAllPendingValidations,
} from "@/ai-agents/healingOrchestrator";

export const runtime = "nodejs";

/**
 * GET /api/healing/sre-validation
 * Get pending SRE validations
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const issueId = searchParams.get("issueId");

    if (issueId) {
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
          ...pending,
          actions: pending.checkpointAvailable
            ? {
                accept: `/api/healing/sre-validation/${issueId}/accept`,
                reject: `/api/healing/sre-validation/${issueId}/reject`,
              }
            : {
                accept: `/api/healing/sre-validation/${issueId}/accept`,
              },
        },
      });
    }

    // Return all pending validations
    const allValidations = getAllPendingValidations();
    return NextResponse.json({
      ok: true,
      data: {
        count: allValidations.length,
        validations: allValidations.map((v) => ({
          issueId: v.issueId,
          status: v.status,
          createdAt: v.createdAt,
          selectedOption: v.selectedOption?.name,
          executionSuccess: v.executionResult?.success,
          checkpointAvailable: v.checkpointAvailable,
          actions: v.checkpointAvailable
            ? {
                accept: `/api/healing/sre-validation/${v.issueId}/accept`,
                reject: `/api/healing/sre-validation/${v.issueId}/reject`,
              }
            : {
                accept: `/api/healing/sre-validation/${v.issueId}/accept`,
              },
        })),
      },
    });
  } catch (error) {
    console.error("Error fetching SRE validations:", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to fetch validations",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/healing/sre-validation
 * Body: { issueId, action: "accept" | "reject", reason?: string, sreUser?: string }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { issueId, action, reason, sreUser = "sre" } = body;

    if (!issueId) {
      return NextResponse.json(
        { ok: false, error: "Missing required field: issueId" },
        { status: 400 }
      );
    }

    if (!action || !["accept", "reject"].includes(action)) {
      return NextResponse.json(
        { ok: false, error: "Invalid action. Must be 'accept' or 'reject'" },
        { status: 400 }
      );
    }

    const pending = getPendingValidation(issueId);
    if (!pending) {
      return NextResponse.json(
        {
          ok: false,
          error: "No pending validation found for issue",
          issueId,
        },
        { status: 404 }
      );
    }

    if (action === "accept") {
      const result = await submitSREAcceptance(issueId, reason, sreUser);
      return NextResponse.json(result, {
        status: result.ok ? 200 : 500,
      });
    }

    if (action === "reject") {
      const result = await submitSRERejection(issueId, reason, sreUser);
      return NextResponse.json(result, {
        status: result.code || (result.ok ? 200 : 500),
      });
    }

    return NextResponse.json(
      { ok: false, error: "Invalid action" },
      { status: 400 }
    );
  } catch (error) {
    console.error("Error processing SRE validation:", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to process validation",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
