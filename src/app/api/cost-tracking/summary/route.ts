import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

async function getSupabase() {
  if (!supabaseUrl || !supabaseKey) {
    return null;
  }
  return createClient(supabaseUrl, supabaseKey);
}

// Demo data - replace with real Supabase queries
const DEMO_COSTS = [
  {
    stage: "plan",
    input_tokens: 1240,
    output_tokens: 450,
    cost_usd: 0.000114,
    issue_id: "pod-crash-1",
  },
  {
    stage: "options",
    input_tokens: 2100,
    output_tokens: 1800,
    cost_usd: 0.000567,
    issue_id: "pod-crash-1",
  },
  {
    stage: "summary",
    input_tokens: 890,
    output_tokens: 320,
    cost_usd: 0.000089,
    issue_id: "pod-crash-1",
  },
  {
    stage: "plan",
    input_tokens: 1240,
    output_tokens: 450,
    cost_usd: 0.000114,
    issue_id: "pod-crash-2",
  },
  {
    stage: "options",
    input_tokens: 2100,
    output_tokens: 1800,
    cost_usd: 0.000567,
    issue_id: "pod-crash-2",
  },
  {
    stage: "summary",
    input_tokens: 890,
    output_tokens: 320,
    cost_usd: 0.000089,
    issue_id: "pod-crash-2",
  },
  {
    stage: "plan",
    input_tokens: 1240,
    output_tokens: 450,
    cost_usd: 0.000114,
    issue_id: "pod-crash-3",
  },
  {
    stage: "options",
    input_tokens: 2100,
    output_tokens: 1800,
    cost_usd: 0.000567,
    issue_id: "pod-crash-3",
  },
  {
    stage: "summary",
    input_tokens: 890,
    output_tokens: 320,
    cost_usd: 0.000089,
    issue_id: "pod-crash-3",
  },
];

async function getLiveExchangeRate(): Promise<number> {
  try {
    const response = await fetch(
      "https://api.frankfurter.app/latest?from=USD&to=INR",
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error("Failed to fetch rate");
    const data = (await response.json()) as { rates?: { INR?: number } };
    return data?.rates?.INR || 93.44;
  } catch (error) {
    console.warn("[CostSummary] Exchange rate fetch failed, using fallback:", error);
    return 93.44;
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const days = parseInt(url.searchParams.get("days") || "28", 10);

    const supabase = await getSupabase();
    let records = DEMO_COSTS;
    let dataSource = "demo";

    if (supabase) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const { data, error } = await supabase
        .from("gemini_cost_records")
        .select("*")
        .gte("created_at", cutoffDate.toISOString());

      if (!error && data) {
        records = data;
        dataSource = "supabase";
        console.log(`[CostSummary] Loaded ${data.length} records from Supabase`);
      } else if (error) {
        console.warn("[CostSummary] Query error, using demo data:", error);
      }
    } else {
      console.warn("[CostSummary] Supabase not configured, using demo data");
    }

    // Fetch live exchange rate
    const exchangeRate = await getLiveExchangeRate();

    // Aggregate by stage
    const stageStats: Record<string, { tokens: number; cost: number }> = {};
    let totalTokens = 0;
    let totalCost = 0;
    const issueIds = new Set<string>();

    for (const record of records) {
      const stageName = record.stage || "unknown";
      if (!stageStats[stageName]) {
        stageStats[stageName] = { tokens: 0, cost: 0 };
      }

      const tokens =
        (record.input_tokens || 0) + (record.output_tokens || 0);
      stageStats[stageName].tokens += tokens;
      stageStats[stageName].cost += record.cost_usd || 0;

      totalTokens += tokens;
      totalCost += record.cost_usd || 0;

      if (record.issue_id) {
        issueIds.add(record.issue_id);
      }
    }

    const healingEventsCount = issueIds.size || 1;
    const costPerHeal = totalCost / (healingEventsCount || 1);
    const monthlyEstimate = costPerHeal * 1000;

    // Convert to INR
    const totalCostINR = totalCost * exchangeRate;
    const costPerHealINR = costPerHeal * exchangeRate;
    const monthlyEstimateINR = monthlyEstimate * exchangeRate;

    return NextResponse.json({
      total_tokens: totalTokens,
      total_cost_usd: parseFloat(totalCost.toFixed(6)),
      total_cost_inr: parseFloat(totalCostINR.toFixed(2)),
      healing_events_count: healingEventsCount,
      stages: stageStats,
      cost_per_heal: parseFloat(costPerHeal.toFixed(6)),
      cost_per_heal_inr: parseFloat(costPerHealINR.toFixed(2)),
      monthly_estimate: parseFloat(monthlyEstimate.toFixed(2)),
      monthly_estimate_inr: parseFloat(monthlyEstimateINR.toFixed(2)),
      exchange_rate: exchangeRate,
      record_count: records.length,
      data_source: dataSource,
    });
  } catch (error) {
    console.error("[CostSummary] Error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 },
    );
  }
}
