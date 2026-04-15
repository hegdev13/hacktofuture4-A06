import { NextResponse } from "next/server";
import { healingRunnerService } from "@/lib/healing/agent-runner";
import type { HealingLogStatus } from "@/lib/healing/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const logs = healingRunnerService.getExecutionLogs({
    agent: url.searchParams.get("agent") || undefined,
    status: (url.searchParams.get("status") as HealingLogStatus | null) || undefined,
    issue_id: url.searchParams.get("issue_id") || undefined,
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
  });

  return NextResponse.json({
    ok: true,
    logs,
    total: logs.length,
  });
}
