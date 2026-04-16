export type PricingEntry = {
  inputPer1k: number;
  outputPer1k: number;
};

// Tokuin-style pricing table: input/output USD cost per 1K tokens.
const TOKUIN_PRICING_TABLE: Record<string, PricingEntry> = {
  "openai.gpt-4": { inputPer1k: 0.03, outputPer1k: 0.06 },
  "openai.gpt-4o-mini": { inputPer1k: 0.005, outputPer1k: 0.015 },
  "anthropic.claude-3-sonnet": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "openrouter.anthropic-sonnet": { inputPer1k: 0.003, outputPer1k: 0.015 },
  // Existing app default Gemini model pricing converted from per-1M to per-1K.
  "google.gemini-1.5-flash": { inputPer1k: 0.000075, outputPer1k: 0.0003 },
};

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

export function resolvePricing(modelName?: string): { key: string; pricing: PricingEntry } {
  const raw = normalize(modelName || "");

  // Exact configured key (provider.model)
  if (raw && TOKUIN_PRICING_TABLE[raw]) {
    return { key: raw, pricing: TOKUIN_PRICING_TABLE[raw] };
  }

  // Best-effort aliases for existing project records.
  if (raw.includes("gpt-4o-mini")) {
    return { key: "openai.gpt-4o-mini", pricing: TOKUIN_PRICING_TABLE["openai.gpt-4o-mini"] };
  }
  if (raw.includes("gpt-4")) {
    return { key: "openai.gpt-4", pricing: TOKUIN_PRICING_TABLE["openai.gpt-4"] };
  }
  if (raw.includes("claude-3-sonnet") || raw.includes("anthropic-sonnet")) {
    return {
      key: "anthropic.claude-3-sonnet",
      pricing: TOKUIN_PRICING_TABLE["anthropic.claude-3-sonnet"],
    };
  }

  // Default to Gemini pricing to keep backward-compatible behavior for current records.
  return {
    key: "google.gemini-1.5-flash",
    pricing: TOKUIN_PRICING_TABLE["google.gemini-1.5-flash"],
  };
}

export function estimateCostUsd(inputTokens: number, outputTokens: number, modelName?: string): number {
  const { pricing } = resolvePricing(modelName);
  const inputCost = (Math.max(0, inputTokens) / 1000) * pricing.inputPer1k;
  const outputCost = (Math.max(0, outputTokens) / 1000) * pricing.outputPer1k;
  return inputCost + outputCost;
}
