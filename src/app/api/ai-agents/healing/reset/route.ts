import { NextResponse } from "next/server";
import { healingRunnerService } from "@/lib/healing/agent-runner";

export const runtime = "nodejs";

export async function POST() {
  healingRunnerService.resetSession();
  return NextResponse.json({ ok: true });
}
