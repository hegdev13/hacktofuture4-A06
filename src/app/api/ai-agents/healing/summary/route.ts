import { NextResponse } from "next/server";
import { healingRunnerService } from "@/lib/healing/agent-runner";
import { generateGeminiHealingSummary } from "@/lib/healing/gemini-summary";

export const runtime = "nodejs";

export async function GET() {
  const status = healingRunnerService.getAgentStatus();
  const logs = healingRunnerService.getExecutionLogs();
  const summary = await generateGeminiHealingSummary(logs, status);

  return NextResponse.json({ ok: true, summary });
}
