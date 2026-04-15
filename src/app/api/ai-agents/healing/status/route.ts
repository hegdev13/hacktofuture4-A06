import { NextResponse } from "next/server";
import { healingRunnerService } from "@/lib/healing/agent-runner";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    status: healingRunnerService.getAgentStatus(),
    lifecycle: healingRunnerService.getIssueLifecycle(),
  });
}
