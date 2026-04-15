const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

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

export async function getGeminiHealingPlan(context) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return fallbackRecommendation(context);
  }

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

    return {
      summary: String(parsed.summary || "AI plan generated."),
      steps: Array.isArray(parsed.steps) ? parsed.steps.map((s) => String(s)) : [],
      confidence: Number(parsed.confidence || 0.6),
      source: "gemini",
      scenario: context.scenario,
      metricsUrl: context.metricsUrl,
    };
  } catch {
    return fallbackRecommendation(context);
  }
}
