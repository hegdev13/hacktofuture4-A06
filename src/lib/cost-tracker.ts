/**
 * Cost Tracker - Logs and calculates Gemini API costs
 * Stores usage metadata from Gemini responses
 */

// Gemini 1.5 Flash pricing (as of April 2026)
export const PRICING = {
  INPUT_PER_1M: 0.075,      // $0.075 per 1M input tokens
  OUTPUT_PER_1M: 0.30,      // $0.30 per 1M output tokens
};

export interface TokenUsage {
  promptTokenCount: number;
  candidatesTokenCount: number;
}

export interface CostRecord {
  id?: string;
  stage: "plan" | "options" | "summary";
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  model: string;
  created_at?: string;
  scenario?: string;
  issue_id?: string;
}

export interface HealingEventCost {
  issue_id: string;
  scenario: string;
  timestamp: string;
  stages: CostRecord[];
  total_cost_per_event: number;
  event_count: number;
}

/**
 * Calculate cost from token counts
 */
export function calculateCost(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * PRICING.INPUT_PER_1M;
  const outputCost = (outputTokens / 1_000_000) * PRICING.OUTPUT_PER_1M;
  return inputCost + outputCost;
}

/**
 * Record token usage to database
 */
export async function recordUsage(
  stage: string,
  usageMetadata: TokenUsage | undefined,
  model: string,
  scenario?: string,
  issueId?: string,
): Promise<CostRecord | null> {
  if (!usageMetadata) return null;

  const costUsd = calculateCost(
    usageMetadata.promptTokenCount,
    usageMetadata.candidatesTokenCount,
  );

  const record: CostRecord = {
    stage: stage as "plan" | "options" | "summary",
    input_tokens: usageMetadata.promptTokenCount,
    output_tokens: usageMetadata.candidatesTokenCount,
    total_tokens: usageMetadata.promptTokenCount + usageMetadata.candidatesTokenCount,
    cost_usd: costUsd,
    model,
    scenario,
    created_at: new Date().toISOString(),
    issue_id: issueId,
  };

  // Store to Supabase
  try {
    const response = await fetch("/api/cost-tracking/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });

    if (response.ok) {
      const saved = await response.json();
      return saved.data || record;
    }
  } catch (error) {
    console.error("[CostTracker] Failed to record usage:", error);
  }

  return record;
}

/**
 * Fetch cost summary for dashboard
 */
export async function getCostSummary(days: number = 28): Promise<{
  total_tokens: number;
  total_cost_usd: number;
  healing_events_count: number;
  stages: Record<string, { tokens: number; cost: number }>;
  cost_per_heal: number;
  monthly_estimate: number;
}> {
  try {
    const response = await fetch(`/api/cost-tracking/summary?days=${days}`);
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.error("[CostTracker] Failed to fetch summary:", error);
  }

  // Fallback
  return {
    total_tokens: 0,
    total_cost_usd: 0,
    healing_events_count: 0,
    stages: {},
    cost_per_heal: 0,
    monthly_estimate: 0,
  };
}
