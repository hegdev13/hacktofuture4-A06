import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { estimateCostUsd, resolvePricing } from "@/lib/cost/tokuin-pricing";

export const runtime = "nodejs";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "";

async function getSupabase() {
  if (!supabaseUrl || !supabaseKey) {
    return null;
  }
  return createClient(supabaseUrl, supabaseKey);
}

async function getLiveExchangeRate(): Promise<number> {
  try {
    const response = await fetch("https://api.frankfurter.app/latest?from=USD&to=INR", {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Failed to fetch rate");
    const data = (await response.json()) as { rates?: { INR?: number } };
    return data?.rates?.INR || 93.44;
  } catch {
    return 93.44;
  }
}

type CostRecordRow = {
  stage: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  issue_id: string | null;
  model: string | null;
  created_at: string | null;
};

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const days = parseInt(url.searchParams.get("days") || "28", 10);
    const modelFilter = (url.searchParams.get("model") || "gemini").trim().toLowerCase();

    const supabase = await getSupabase();
    if (!supabase) {
      return NextResponse.json(
        {
          error: "supabase_not_configured",
          details: "Supabase credentials are required for tokuin-style cost calculation.",
        },
        { status: 503 },
      );
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    let query = supabase
      .from("gemini_cost_records")
      .select("stage,input_tokens,output_tokens,cost_usd,issue_id,model,created_at")
      .gte("created_at", cutoffDate.toISOString());

    if (modelFilter && modelFilter !== "all") {
      query = query.ilike("model", `%${modelFilter}%`);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const records = (Array.isArray(data) ? data : []) as CostRecordRow[];
    const exchangeRate = await getLiveExchangeRate();

    const stageStats: Record<string, { tokens: number; cost: number }> = {};
    let totalTokens = 0;
    let totalCost = 0;
    const issueIds = new Set<string>();
    const recentRecords: Array<{
      stage: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cost_usd: number;
      created_at: string | null;
    }> = [];

    // Track the model used most often so clients can display active pricing profile.
    const modelUsage = new Map<string, number>();

    for (const record of records) {
      const stageName = record.stage || "unknown";
      const inputTokens = Number(record.input_tokens || 0);
      const outputTokens = Number(record.output_tokens || 0);
      const tokens = inputTokens + outputTokens;

      const modelName = (record.model || "").trim();
      const modelKey = resolvePricing(modelName).key;
      modelUsage.set(modelKey, (modelUsage.get(modelKey) || 0) + 1);

      const estimatedCost = estimateCostUsd(inputTokens, outputTokens, modelName);
      const recordedCost = Number(record.cost_usd || 0);
      const costUsd = recordedCost > 0 ? recordedCost : estimatedCost;

      if (!stageStats[stageName]) {
        stageStats[stageName] = { tokens: 0, cost: 0 };
      }
      stageStats[stageName].tokens += tokens;
      stageStats[stageName].cost += costUsd;

      totalTokens += tokens;
      totalCost += costUsd;

      recentRecords.push({
        stage: stageName,
        model: modelName || modelKey,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: tokens,
        cost_usd: costUsd,
        created_at: record.created_at,
      });

      if (record.issue_id) {
        issueIds.add(record.issue_id);
      }
    }

    const healingEventsCount = issueIds.size || 1;
    const costPerHeal = totalCost / healingEventsCount;
    const monthlyEstimate = costPerHeal * 1000;

    const totalCostINR = totalCost * exchangeRate;
    const costPerHealINR = costPerHeal * exchangeRate;
    const monthlyEstimateINR = monthlyEstimate * exchangeRate;

    const mostUsedModel = Array.from(modelUsage.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "google.gemini-1.5-flash";
    const pricing = resolvePricing(mostUsedModel).pricing;
    recentRecords.sort((a, b) => {
      const aTime = a.created_at ? Date.parse(a.created_at) : 0;
      const bTime = b.created_at ? Date.parse(b.created_at) : 0;
      return bTime - aTime;
    });

    return NextResponse.json({
      total_tokens: totalTokens,
      total_cost_usd: parseFloat(totalCost.toFixed(6)),
      total_cost_inr: parseFloat(totalCostINR.toFixed(2)),
      healing_events_count: healingEventsCount,
      stages: stageStats,
      cost_per_heal: parseFloat(costPerHeal.toFixed(6)),
      cost_per_heal_inr: parseFloat(costPerHealINR.toFixed(4)),
      monthly_estimate: parseFloat(monthlyEstimate.toFixed(2)),
      monthly_estimate_inr: parseFloat(monthlyEstimateINR.toFixed(2)),
      exchange_rate: exchangeRate,
      record_count: records.length,
      model_filter: modelFilter || "gemini",
      data_source: "supabase_tokuin_pricing",
      pricing_profile: {
        model: mostUsedModel,
        input_per_1k: pricing.inputPer1k,
        output_per_1k: pricing.outputPer1k,
      },
      recent_records: recentRecords.slice(0, 12),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
