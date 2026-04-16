import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const INPUT_COST_PER_1K = Number(process.env.GEMINI_INPUT_COST_PER_1K || 0.000075);
const OUTPUT_COST_PER_1K = Number(process.env.GEMINI_OUTPUT_COST_PER_1K || 0.0003);

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function estimateTokens(text) {
  const s = String(text || "").trim();
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}

function extractJson(text) {
  const cleaned = String(text || "").replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeDecision(raw, task, context) {
  const data = raw && typeof raw === "object" ? raw : {};
  const normalized = {
    agent: String(data.agent || "LLM_AGENT"),
    task: String(data.task || task),
    service: String(data.service || context.targetName || context.scenario || "unknown"),
    issue: String(data.issue || "unknown"),
    decision: String(data.decision || "observe"),
    confidence: clamp01(data.confidence),
    reason: String(data.reason || "No reason provided"),
    metrics_snapshot: {
      cpu: String(data.metrics_snapshot?.cpu || "unknown"),
      memory: String(data.metrics_snapshot?.memory || "unknown"),
      latency: String(data.metrics_snapshot?.latency || "unknown"),
    },
    metadata: {
      complexity: ["low", "medium", "high"].includes(String(data.metadata?.complexity || "").toLowerCase())
        ? String(data.metadata.complexity).toLowerCase()
        : "medium",
      estimated_input_tokens: Number(data.metadata?.estimated_input_tokens || 0),
      estimated_output_tokens: Number(data.metadata?.estimated_output_tokens || 0),
    },
  };

  if (!normalized.agent || !normalized.decision) {
    throw new Error("Invalid LLM response");
  }
  return normalized;
}

function computeCost(inputTokens, outputTokens) {
  const inCost = (inputTokens / 1000) * INPUT_COST_PER_1K;
  const outCost = (outputTokens / 1000) * OUTPUT_COST_PER_1K;
  return inCost + outCost;
}

function printLLMLogTable(data, cost) {
  const row = [
    data.agent,
    data.task,
    data.service,
    data.issue,
    data.decision,
    data.confidence,
    data.reason,
    data.metrics_snapshot.cpu,
    data.metrics_snapshot.memory,
    data.metrics_snapshot.latency,
    `$${cost.toFixed(4)}`,
  ];

  console.log(`
+------------+-----------+--------------+-------------------+------------------+------------+---------------------------+--------+--------+----------+--------+
| Agent      | Task      | Service      | Issue             | Decision         | Confidence | Reason                    | CPU    | Memory | Latency  | Cost   |
+------------+-----------+--------------+-------------------+------------------+------------+---------------------------+--------+--------+----------+--------+
| ${row.map(x => String(x).slice(0, 10).padEnd(10)).join(" | ")} |
+------------+-----------+--------------+-------------------+------------------+------------+---------------------------+--------+--------+----------+--------+
`);
}

function appendStructuredLog(entry) {
  try {
    const logsDir = join(process.cwd(), "logs");
    mkdirSync(logsDir, { recursive: true });
    const file = join(logsDir, "llm-agent-logs.jsonl");
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Logging failure should not break healing.
  }
}

function promptForTask(task, context) {
  return [
    "You are part of a production-grade Kubernetes self-healing system.",
    "Your role:",
    "- Perform the assigned task (Root Cause Analysis / Planning / Validation)",
    "- Return structured output for observability and cost tracking",
    "- Output MUST be machine-readable and consistent",
    "IMPORTANT:",
    "- Return ONLY JSON (no explanation outside JSON)",
    "- Keep values concise",
    "- Do NOT hallucinate unknown values",
    `Assigned task: ${task}`,
    `Scenario: ${context.scenario || "unknown"}`,
    `Metrics URL: ${context.metricsUrl || "unknown"}`,
    `Target: ${context.targetNamespace || "default"}/${context.targetName || "auto"} (${context.targetKind || "pod"})`,
    `Dry run: ${context.dryRun ? "true" : "false"}`,
    "Return in this exact format:",
    "{",
    "  \"agent\": \"<agent_name>\",",
    "  \"task\": \"<RCA | planning | validation>\",",
    "  \"service\": \"<affected_service>\",",
    "  \"issue\": \"<detected_issue>\",",
    "  \"decision\": \"<final_action>\",",
    "  \"confidence\": <0 to 1>,",
    "  \"reason\": \"<short explanation>\",",
    "  \"metrics_snapshot\": {",
    "    \"cpu\": \"<value>\",",
    "    \"memory\": \"<value>\",",
    "    \"latency\": \"<value>\"",
    "  },",
    "  \"metadata\": {",
    "    \"complexity\": \"<low | medium | high>\",",
    "    \"estimated_input_tokens\": \"<number>\",",
    "    \"estimated_output_tokens\": \"<number>\"",
    "  }",
    "}",
  ].join("\n");
}

async function runSingleTask(task, context, apiKey) {
  const prompt = promptForTask(task, context);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 600,
      },
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Gemini API ${response.status}`);
  }

  const raw = await response.json();
  const text =
    raw?.candidates?.[0]?.content?.parts
      ?.map((p) => p?.text || "")
      .join("\n")
      .trim() || "";

  const parsed = extractJson(text);
  const normalized = normalizeDecision(parsed, task, context);

  const usage = raw?.usageMetadata || {};
  const inputTokens = Number(usage.promptTokenCount || usage.inputTokenCount || estimateTokens(prompt));
  const outputTokens = Number(usage.candidatesTokenCount || usage.outputTokenCount || estimateTokens(text));
  normalized.metadata.estimated_input_tokens = inputTokens;
  normalized.metadata.estimated_output_tokens = outputTokens;

  const cost = computeCost(inputTokens, outputTokens);
  normalized.metadata.cost_usd = Number(cost.toFixed(6));
  normalized.metadata.model = GEMINI_MODEL;
  printLLMLogTable(normalized, cost);

  appendStructuredLog({
    ...normalized,
    metadata: {
      ...normalized.metadata,
      model: GEMINI_MODEL,
      cost_usd: Number(cost.toFixed(6)),
      timestamp: new Date().toISOString(),
    },
  });

  return { data: normalized, cost };
}

function fallbackRecommendation(context) {
  const fallback = {
    summary: "Fallback plan: run observer, detector, RCA, then execution agent with kubectl remediation.",
    steps: [
      "Collect live metrics and pod readiness",
      "Detect unstable pods and dependency issues",
      "Select lowest-risk remediation",
      "Verify readiness after fix",
    ],
    confidence: 0.45,
    source: "fallback",
    scenario: context.scenario,
    metricsUrl: context.metricsUrl,
    assessments: [],
  };

  appendStructuredLog({
    agent: "LLM_AGENT",
    task: "planning",
    service: context.targetName || context.scenario || "unknown",
    issue: "fallback",
    decision: "observe",
    confidence: 0.45,
    reason: "Gemini unavailable, deterministic fallback",
    metrics_snapshot: { cpu: "unknown", memory: "unknown", latency: "unknown" },
    metadata: {
      complexity: "low",
      estimated_input_tokens: 0,
      estimated_output_tokens: 0,
      model: GEMINI_MODEL,
      cost_usd: 0,
      timestamp: new Date().toISOString(),
    },
  });

  return fallback;
}

export async function getGeminiHealingPlan(context) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return fallbackRecommendation(context);
  }

  try {
    const tasks = ["RCA", "planning", "validation"];
    const assessments = [];

    for (const task of tasks) {
      const res = await runSingleTask(task, context, apiKey);
      assessments.push(res.data);
    }

    const planning = assessments.find((a) => a.task.toLowerCase() === "planning") || assessments[0];
    const rca = assessments.find((a) => a.task.toLowerCase() === "rca") || assessments[0];
    const validation = assessments.find((a) => a.task.toLowerCase() === "validation") || assessments[assessments.length - 1];

    return {
      summary: planning.reason,
      steps: [
        `RCA: ${rca.decision}`,
        `Plan: ${planning.decision}`,
        `Validate: ${validation.decision}`,
      ],
      confidence: planning.confidence,
      source: "gemini",
      scenario: context.scenario,
      metricsUrl: context.metricsUrl,
      assessments,
    };
  } catch {
    return fallbackRecommendation(context);
  }
}
