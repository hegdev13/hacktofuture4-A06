import { NextRequest, NextResponse } from "next/server";

/**
 * Debug endpoint to verify the system is working
 */
export async function GET(request: NextRequest) {
  return NextResponse.json(
    {
      status: "ok",
      message: "Self-heal cloud API is running",
      timestamp: new Date().toISOString(),
      endpoints: {
        metrics: "/api/metrics/context",
        health: "/api/debug",
      },
      ngrok_hint: "Make sure this endpoint is accessed via ngrok public URL, not localhost",
    },
    { status: 200 }
  );
}
