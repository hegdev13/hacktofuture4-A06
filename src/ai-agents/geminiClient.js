import { estimateCostUsd } from "@/lib/cost/tokuin-pricing";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

function fallbackRecommendation({ scenario, metricsUrl }) {
  return {
    summary: "Fallback plan: run observer, detector, RCA, then execution agent with kubectl remediation.",
    steps: [
      "Collect live metrics and pod readiness",
      "Detect unstable pods and dependency issues",
      "Select lowest-risk remediation (restart pod/deployment)",
      "Verify resource readiness after fix",
    ],
    confidence: 0.45,
    source: "fallback",
    scenario,
    metricsUrl,
  };
}

function fallbackMultiOptions({ scenario, rootCause, affectedPods }) {
  return {
    options: [
      {
        id: "option_a",
        name: "Quick Restart",
        description: `Restart ${rootCause} pod immediately`,
        steps: [
          `Delete pod: kubectl delete pod ${rootCause} -n default`,
          "Wait for deployment controller to create new pod",
          "Verify service connectivity",
        ],
        cost: {
          downtime: "30-60 seconds",
          downtime_seconds: 45,
          resource_impact: "Minimal",
          risk_level: "low",
          execution_time: "45 seconds",
        },
        pros: ["Fastest approach", "Minimal resource overhead"],
        cons: ["Brief service disruption", "May not fix root cause"],
        confidence: 0.65,
      },
      {
        id: "option_b",
        name: "Rollout Restart",
        description: "Perform rolling restart of deployment",
        steps: [
          `Rollout restart: kubectl rollout restart deployment/${rootCause} -n default`,
          "Monitor rollout status",
          "Verify all pods are ready",
        ],
        cost: {
          downtime: "Minimal",
          downtime_seconds: 5,
          resource_impact: "Moderate (temp 2x pod count)",
          risk_level: "medium",
          execution_time: "2-3 minutes",
        },
        pros: ["Zero-downtime rolling update", "Controlled pod replacement"],
        cons: ["Longer execution time", "Temporary resource increase"],
        confidence: 0.78,
      },
      {
        id: "option_c",
        name: "Dependency Reset",
        description: "Restart dependent services then target",
        steps: [
          "Identify and restart dependencies first",
          `Restart ${rootCause} pod`,
          "Monitor cascade recovery",
          "Validate full service health",
        ],
        cost: {
          downtime: "60-90 seconds",
          downtime_seconds: 75,
          resource_impact: "Moderate",
          risk_level: "medium",
          execution_time: "3-4 minutes",
        },
        pros: ["Addresses upstream issues", "Higher success rate"],
        cons: ["Longer total downtime", "More complex recovery"],
        confidence: 0.82,
      },
    ],
    selected_option: "option_b",
    selection_reason: "Rolling restart provides best balance of speed, reliability, and zero-downtime deployment.",
    source: "fallback",
    reason: "gemini_error",
  };
}

export async function getGeminiHealingPlan(context) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    console.log("[GEMINI][HEALING] No API key found. Returning fallback recommendation.");
    return fallbackRecommendation(context);
  }
  
  console.log("[GEMINI][HEALING] API key found. Generating healing plan via Gemini...");

  const prompt = [
    "You are a Kubernetes SRE assistant.",
    "Return strict JSON only with keys: summary, steps, confidence.",
    "Use short actionable steps for an automated self-healing pipeline.",
    `Scenario: ${context.scenario}`,
    `Metrics URL: ${context.metricsUrl || "(not provided)"}`,
    `Dry run: ${context.dryRun ? "true" : "false"}`,
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          topP: 0.9,
          maxOutputTokens: 500,
        },
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      return fallbackRecommendation(context);
    }

    const data = await response.json();
    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p) => p?.text || "")
        .join("\n")
        .trim() || "";

    if (!text) {
      return fallbackRecommendation(context);
    }

    const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(cleaned);

    // Capture token usage metadata
    const usageMetadata = data?.usageMetadata || {};
    const inputTokens = usageMetadata.promptTokenCount || 0;
    const outputTokens = usageMetadata.candidatesTokenCount || 0;

    // Record cost asynchronously (non-blocking)
    if (inputTokens > 0 || outputTokens > 0) {
      fetch("/api/cost-tracking/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: "plan",
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          cost_usd: estimateCostUsd(inputTokens, outputTokens, GEMINI_MODEL),
          model: GEMINI_MODEL,
          scenario: context.scenario,
        }),
      }).catch((e) => console.error("[CostTracking] Failed to record plan costs:", e));
    }

    return {
      summary: String(parsed.summary || "AI plan generated."),
      steps: Array.isArray(parsed.steps) ? parsed.steps.map((s) => String(s)) : [],
      confidence: Number(parsed.confidence || 0.6),
      source: "gemini",
      scenario: context.scenario,
      metricsUrl: context.metricsUrl,
      usageMetadata: {
        inputTokens,
        outputTokens,
        cost: estimateCostUsd(inputTokens, outputTokens, GEMINI_MODEL),
      },
    };
  } catch {
    return fallbackRecommendation(context);
  }
}

/**
 * Generate multiple remediation options with cost analysis
 * Returns 3 options with pros/cons and selected best option
 */
export async function getRemediationOptions(context) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const { rootCause, failureChain, affectedCount = 0 } = context;

  if (!apiKey) {
    console.log("[GEMINI][REMEDIATION] No API key found. Returning fallback options.");
    return {
      ...fallbackMultiOptions({
        scenario: context.scenario,
        rootCause: rootCause || "unknown-pod",
        affectedPods: affectedCount,
      }),
      reason: "no_api_key",
    };
  }

  console.log("[GEMINI][REMEDIATION] API key found. Generating options via Gemini...");

  const prompt = [
    "You are a Kubernetes SRE expert. Generate exactly 3 remediation strategies as JSON.",
    "Return ONLY valid JSON with this structure:",
    "{",
    '  "options": [',
    '    {',
    '      "id": "option_a", "name": "...", "description": "...",',
    '      "steps": ["...", "..."],',
    '      "cost": {',
    '        "downtime": "description", "downtime_seconds": number,',
    '        "resource_impact": "Minimal|Moderate|High",',
    '        "risk_level": "low|medium|high",',
    '        "execution_time": "X minutes"',
    "      },",
    '      "pros": ["..."], "cons": ["..."], "confidence": 0.0-1.0',
    "    },",
    "    ... (option_b, option_c)",
    "  ],",
    '  "selected_option": "option_a",',
    '  "selection_reason": "Why this option is best..."',
    "}",
    "",
    `Root cause: ${rootCause || "unknown pod failure"}`,
    `Failure chain: ${(failureChain || []).join(" -> ") || "untraced"}`,
    `Affected resources count: ${affectedCount}`,
    "Generate practical Kubernetes recovery strategies ONLY.",
  ].join("\n");

  try {
    const requestWithModel = async (modelName) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            topP: 0.9,
            maxOutputTokens: 1500,
          },
        }),
        cache: "no-store",
      });

      return response;
    };

    let modelUsed = GEMINI_MODEL;
    let response = await requestWithModel(modelUsed);

    // Some projects still configure a retired model; auto-retry with a stable fallback.
    if (!response.ok && response.status === 404 && modelUsed !== "gemini-2.0-flash") {
      const notFoundText = await response.text();
      console.warn(`[GEMINI][REMEDIATION] Model ${modelUsed} unavailable. Retrying with gemini-2.0-flash. Details: ${notFoundText}`);
      modelUsed = "gemini-2.0-flash";
      response = await requestWithModel(modelUsed);
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[GEMINI][REMEDIATION] API Error ${response.status}: ${errorText}`);
      if (response.status === 429) {
        return {
          ...fallbackMultiOptions({ scenario: context.scenario, rootCause, affectedPods: affectedCount }),
          reason: "quota_exceeded",
        };
      }
      if (response.status === 404) {
        return {
          ...fallbackMultiOptions({ scenario: context.scenario, rootCause, affectedPods: affectedCount }),
          reason: "model_unavailable",
        };
      }
      return fallbackMultiOptions({ scenario: context.scenario, rootCause, affectedPods: affectedCount });
    }

    console.log(`[GEMINI][REMEDIATION] Using model: ${modelUsed}`);

    const data = await response.json();
    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p) => p?.text || "")
        .join("\n")
        .trim() || "";

    if (!text) {
      console.error("[GEMINI][REMEDIATION] No text generated. Response:", JSON.stringify(data, null, 2));
      return fallbackMultiOptions({ scenario: context.scenario, rootCause, affectedPods: affectedCount });
    }

    const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("[GEMINI][REMEDIATION] JSON parse error:", parseErr.message, "Text:", cleaned.substring(0, 200));
      return fallbackMultiOptions({ scenario: context.scenario, rootCause, affectedPods: affectedCount });
    }

    // Validate structure
    if (!Array.isArray(parsed.options) || parsed.options.length < 3) {
      console.error("[GEMINI][REMEDIATION] Invalid response structure. Options count:", parsed.options?.length);
      return fallbackMultiOptions({ scenario: context.scenario, rootCause, affectedPods: affectedCount });
    }

    console.log("[GEMINI][REMEDIATION] Successfully generated 3+ options via Gemini");

      // Capture token usage metadata
      const usageMetadata = data?.usageMetadata || {};
      const inputTokens = usageMetadata.promptTokenCount || 0;
      const outputTokens = usageMetadata.candidatesTokenCount || 0;

      // Record cost asynchronously (non-blocking)
      if (inputTokens > 0 || outputTokens > 0) {
        fetch("/api/cost-tracking/record", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stage: "options",
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            cost_usd: estimateCostUsd(inputTokens, outputTokens, modelUsed),
            model: modelUsed,
            scenario: context.scenario,
          }),
        }).catch((e) => console.error("[CostTracking] Failed to record options costs:", e));
      }

      return {
      options: parsed.options.map((opt) => ({
        id: String(opt.id || "option_unknown"),
        name: String(opt.name || "Option"),
        description: String(opt.description || ""),
        steps: Array.isArray(opt.steps) ? opt.steps.map((s) => String(s)) : [],
        cost: {
          downtime: String(opt.cost?.downtime || "unknown"),
          downtime_seconds: Number(opt.cost?.downtime_seconds || 0),
          resource_impact: String(opt.cost?.resource_impact || "Unknown"),
          risk_level: String(opt.cost?.risk_level || "medium"),
          execution_time: String(opt.cost?.execution_time || "unknown"),
        },
        pros: Array.isArray(opt.pros) ? opt.pros.map((p) => String(p)) : [],
        cons: Array.isArray(opt.cons) ? opt.cons.map((c) => String(c)) : [],
        confidence: Number(opt.confidence || 0.5),
      })),
      selected_option: String(parsed.selected_option || "option_a"),
      selection_reason: String(parsed.selection_reason || "Best balance of risk and effectiveness."),
      source: "gemini",
      usageMetadata: {
        inputTokens,
        outputTokens,
        cost: estimateCostUsd(inputTokens, outputTokens, modelUsed),
      },
    };
  } catch (error) {
    console.error("[GEMINI][REMEDIATION] Unhandled error:", error);
    return fallbackMultiOptions({ scenario: context.scenario, rootCause, affectedPods: affectedCount });
  }
}
