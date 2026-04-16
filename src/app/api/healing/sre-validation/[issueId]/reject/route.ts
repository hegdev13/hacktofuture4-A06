import { NextResponse } from "next/server";
import { submitSRERejection } from "@/ai-agents/healingOrchestrator";

export const runtime = "nodejs";

/**
 * POST /api/healing/sre-validation/{issueId}/reject
 * SRE rejects the execution results - triggers rollback
 * Body: { reason?: string, sreUser?: string }
 */
export async function POST(
  request: Request,
  { params }: { params: { issueId: string } }
) {
  try {
    const { issueId } = params;
    const body = await request.json().catch(() => ({}));
    const { reason, sreUser = "sre" } = body;

    const result = await submitSRERejection(issueId, reason, sreUser);

    return NextResponse.json(result, {
      status: result.code || (result.ok ? 200 : 500),
    });
  } catch (error) {
    console.error("Error rejecting SRE validation:", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to reject validation",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
