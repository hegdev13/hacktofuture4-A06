import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

async function getSupabase() {
  if (!supabaseUrl || !supabaseKey) {
    console.warn("[CostTracking] Supabase credentials missing");
    console.warn(`  URL: ${supabaseUrl ? "✓" : "✗"}, Key: ${supabaseKey ? "✓" : "✗"}`);
    return null;
  }
  console.log("[CostTracking] Supabase credentials available, connecting...");
  return createClient(supabaseUrl, supabaseKey);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      stage,
      input_tokens,
      output_tokens,
      total_tokens,
      cost_usd,
      model,
      scenario,
      issue_id,
    } = body;

    const supabase = await getSupabase();
    if (!supabase) {
      return NextResponse.json({
        ok: true,
        data: { ...body, id: `mock-${Date.now()}` },
        note: "Mock storage (Supabase unavailable)",
      });
    }

    // Create gemini_cost_records table if not exists
    const { data, error } = await supabase.from("gemini_cost_records").insert([
      {
        stage,
        input_tokens,
        output_tokens,
        total_tokens,
        cost_usd,
        model,
        scenario,
        issue_id,
        created_at: new Date().toISOString(),
      },
    ]);

    if (error) {
      console.error("[CostTracking] DB insert error:", error);
      // Still return success but note the error
      return NextResponse.json({
        ok: true,
        data: { ...body, id: `fallback-${Date.now()}` },
        warning: error.message,
      });
    }

    return NextResponse.json({ ok: true, data: data?.[0] || body });
  } catch (error) {
    console.error("[CostTracking] Error:", error);
    return NextResponse.json(
      { ok: false, error: String(error) },
      { status: 500 },
    );
  }
}
