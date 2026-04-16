import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  void request;
  return NextResponse.json(
    {
      ok: false,
      error: "deprecated_endpoint",
      details: "Healing is restricted to the /dashboard/healing Self Heal button flow.",
    },
    { status: 410 },
  );
}
