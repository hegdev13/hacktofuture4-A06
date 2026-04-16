import { NextResponse } from "next/server";
import { submitSREAcceptance } from "@/ai-agents/healingOrchestrator";

export const runtime = "nodejs";

/**
 * POST /api/healing/sre-validation/{issueId}/accept
 * SRE accepts the execution results
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

    const result = await submitSREAcceptance(issueId, reason, sreUser);

    return NextResponse.json(result, {
      status: result.ok ? 200 : 500,
    });
  } catch (error) {
    console.error("Error accepting SRE validation:", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to accept validation",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
