import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const INPUT_COST_PER_1K = Number(process.env.GEMINI_INPUT_COST_PER_1K || 0.000075);
const OUTPUT_COST_PER_1K = Number(process.env.GEMINI_OUTPUT_COST_PER_1K || 0.0003);
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL_FALLBACKS = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"];

function getCandidateModels() {
  const envList = String(process.env.GEMINI_FALLBACK_MODELS || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const combined = [GEMINI_MODEL, ...envList, ...DEFAULT_MODEL_FALLBACKS];
  return Array.from(new Set(combined));
}

function getCandidateApiKeys() {
  const csv = String(process.env.GEMINI_API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const direct = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_ALT,
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    process.env.GOOGLE_API_KEY,
  ]
    .map((k) => String(k || "").trim())
    .filter(Boolean);

  return Array.from(new Set([...direct, ...csv]));
}

function getGeminiBaseUrl() {
  return (
    process.env.GOOGLE_GEMINI_BASE_URL ||
    process.env.GEMINI_API_BASE_URL ||
    process.env.GEMINI_BASEURL ||
    process.env.GEMINI_BASE_URL ||
    DEFAULT_GEMINI_BASE_URL
  ).replace(/\/+$/, "");
}

function buildGeminiRequestConfig(apiKey, modelName = GEMINI_MODEL) {
  const baseUrl = getGeminiBaseUrl();
  const endpoint = `/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
  const isDirectGoogleApi = /(^https?:\/\/)?([^/]+\.)?generativelanguage\.googleapis\.com/i.test(baseUrl);

  if (isDirectGoogleApi) {
    return {
      url: `${baseUrl}${endpoint}?key=${encodeURIComponent(apiKey)}`,
      headers: { "Content-Type": "application/json" },
      viaTokentapProxy: false,
    };
  }

  // tokentap proxy mode: keep API key in header and forward through local base URL.
  return {
    url: `${baseUrl}${endpoint}`,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    viaTokentapProxy: true,
  };
}

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

async function runSingleTask(task, context, apiKeys) {
  const prompt = promptForTask(task, context);
  const candidateModels = getCandidateModels();
  let raw = null;
  let requestConfig = null;
  let selectedModel = GEMINI_MODEL;
  let lastStatus = 0;
  const keys = Array.isArray(apiKeys) ? apiKeys : [apiKeys];

  for (const apiKey of keys) {
    for (const modelName of candidateModels) {
      const config = buildGeminiRequestConfig(apiKey, modelName);
      const response = await fetch(config.url, {
        method: "POST",
        headers: config.headers,
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

      if (response.ok) {
        raw = await response.json();
        requestConfig = config;
        selectedModel = modelName;
        break;
      }

      lastStatus = response.status;
      if (response.status === 404 || response.status === 429) {
        continue;
      }

      throw new Error(`Gemini API ${response.status}`);
    }

    if (raw) break;
  }

  if (!raw || !requestConfig) {
    throw new Error(`Gemini API ${lastStatus || 404}`);
  }

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
  normalized.metadata.model = selectedModel;
  normalized.metadata.via_tokentap_proxy = requestConfig.viaTokentapProxy;
  printLLMLogTable(normalized, cost);

  appendStructuredLog({
    ...normalized,
    metadata: {
      ...normalized.metadata,
      model: selectedModel,
      cost_usd: Number(cost.toFixed(6)),
      via_tokentap_proxy: requestConfig.viaTokentapProxy,
      timestamp: new Date().toISOString(),
    },
  });

  return { data: normalized, cost, model: selectedModel };
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
          llm_analysis_usd: 0,
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
          llm_analysis_usd: 0,
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
          llm_analysis_usd: 0,
        },
        pros: ["Addresses upstream issues", "Higher success rate"],
        cons: ["Longer total downtime", "More complex recovery"],
        confidence: 0.82,
      },
    ],
    selected_option: "option_b",
    selection_reason: "Rolling restart provides best balance of speed, reliability, and zero-downtime deployment.",
    source: "fallback",
    reason: "gemini_unavailable",
    usageMetadata: {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    },
  };
}

function distributeOptionCost(options, totalCostUsd, totalOutputTokens) {
  const safeTotalCost = Number(totalCostUsd || 0);
  if (!Array.isArray(options) || options.length === 0 || safeTotalCost <= 0) {
    return options || [];
  }

  const rawWeights = options.map((opt) => {
    const text = `${opt?.name || ""} ${opt?.description || ""} ${(opt?.steps || []).join(" ")}`;
    return Math.max(1, estimateTokens(text));
  });

  const weightSum = rawWeights.reduce((sum, w) => sum + w, 0);
  if (!weightSum) {
    const even = safeTotalCost / options.length;
    return options.map((opt) => ({
      ...opt,
      cost: { ...(opt.cost || {}), llm_analysis_usd: Number(even.toFixed(6)) },
    }));
  }

  const outputCostUsd = (Number(totalOutputTokens || 0) / 1000) * OUTPUT_COST_PER_1K;
  const inputCostUsd = Math.max(0, safeTotalCost - outputCostUsd);
  const evenInputShare = inputCostUsd / options.length;

  return options.map((opt, idx) => {
    const outputShare = outputCostUsd * (rawWeights[idx] / weightSum);
    const optionCost = Math.max(0, evenInputShare + outputShare);
    return {
      ...opt,
      cost: {
        ...(opt.cost || {}),
        llm_analysis_usd: Number(optionCost.toFixed(6)),
      },
    };
  });
}

export async function getGeminiHealingPlan(context) {
  const apiKeys = getCandidateApiKeys();
  if (!apiKeys.length) {
    return fallbackRecommendation(context);
  }

  try {
    const tasks = ["RCA", "planning", "validation"];
    const assessments = [];

    for (const task of tasks) {
      const res = await runSingleTask(task, context, apiKeys);
      assessments.push(res.data);
    }

    const planning = assessments.find((a) => a.task.toLowerCase() === "planning") || assessments[0];
    const rca = assessments.find((a) => a.task.toLowerCase() === "rca") || assessments[0];
    const validation = assessments.find((a) => a.task.toLowerCase() === "validation") || assessments[assessments.length - 1];

    // Aggregate usage across all task calls.
    const inputTokens = assessments.reduce(
      (sum, item) => sum + Number(item?.metadata?.estimated_input_tokens || 0),
      0,
    );
    const outputTokens = assessments.reduce(
      (sum, item) => sum + Number(item?.metadata?.estimated_output_tokens || 0),
      0,
    );

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
          cost_usd: (inputTokens / 1000000) * 0.075 + (outputTokens / 1000000) * 0.30,
          model: GEMINI_MODEL,
          scenario: context.scenario,
        }),
      }).catch((e) => console.error("[CostTracking] Failed to record plan costs:", e));
    }

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
      usageMetadata: {
        inputTokens,
        outputTokens,
        cost: (inputTokens / 1000000) * 0.075 + (outputTokens / 1000000) * 0.30,
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
  const apiKeys = getCandidateApiKeys();
  const {
    rootCause,
    failureChain,
    affectedCount = 0,
    scenario,
    targetNamespace = "default",
    targetKind = "pod",
  } = context;

  if (!apiKeys.length) {
    return {
      ...fallbackMultiOptions({ scenario: context.scenario, rootCause: rootCause || "unknown-pod", affectedPods: affectedCount }),
      reason: "no_api_key",
    };
  }

  const prompt = [
    "You are a Kubernetes SRE expert. Generate exactly 3 remediation strategies as JSON.",
    "Tailor options to the target service and current incident.",
    "Return ONLY valid JSON with this structure:",
    "{",
    '  "options": [',
    '    {',
    '      "id": "option_a", "name": "...", "description": "...",',
    '      "steps": ["kubectl ...", "..."],',
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
    '  "selection_reason": "Why this option is best for this service..."',
    "}",
    "",
    `Scenario: ${scenario || "pod-crash"}`,
    `Target service/workload: ${rootCause || "unknown pod failure"}`,
    `Target kind: ${targetKind}`,
    `Target namespace: ${targetNamespace}`,
    `Failure chain: ${(failureChain || []).join(" -> ") || "untraced"}`,
    `Affected resources count: ${affectedCount}`,
    "Generate practical Kubernetes recovery strategies ONLY.",
  ].join("\n");

  const candidateModels = getCandidateModels();

  try {
    let data = null;
    let selectedModel = GEMINI_MODEL;
    let lastStatus = 0;
    let sawQuota = false;

    for (const apiKey of apiKeys) {
      for (const modelName of candidateModels) {
        const requestConfig = buildGeminiRequestConfig(apiKey, modelName);
        const response = await fetch(requestConfig.url, {
          method: "POST",
          headers: requestConfig.headers,
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

        if (response.ok) {
          data = await response.json();
          selectedModel = modelName;
          break;
        }

        lastStatus = response.status;
        if (response.status === 429) {
          sawQuota = true;
          continue;
        }
        if (response.status === 404) {
          continue;
        }

        return {
          ...fallbackMultiOptions({ scenario: context.scenario, rootCause, affectedPods: affectedCount }),
          reason: "request_failed",
        };
      }

      if (data) break;
    }

    if (!data) {
      const reason = sawQuota ? "quota_exceeded" : lastStatus === 404 ? "model_unavailable" : "request_failed";
      return {
        ...fallbackMultiOptions({ scenario: context.scenario, rootCause, affectedPods: affectedCount }),
        reason,
      };
    }

    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p) => p?.text || "")
        .join("\n")
        .trim() || "";

    if (!text) {
      return {
        ...fallbackMultiOptions({ scenario: context.scenario, rootCause, affectedPods: affectedCount }),
        reason: "empty_response",
      };
    }

    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== "object") {
      return {
        ...fallbackMultiOptions({ scenario: context.scenario, rootCause, affectedPods: affectedCount }),
        reason: "invalid_json",
      };
    }

    if (!Array.isArray(parsed.options) || parsed.options.length < 3) {
      return {
        ...fallbackMultiOptions({ scenario: context.scenario, rootCause, affectedPods: affectedCount }),
        reason: "invalid_structure",
      };
    }

    const usageMetadata = data?.usageMetadata || {};
    const inputTokens = Number(usageMetadata.promptTokenCount || usageMetadata.inputTokenCount || estimateTokens(prompt));
    const outputTokens = Number(usageMetadata.candidatesTokenCount || usageMetadata.outputTokenCount || estimateTokens(text));
    const totalCost = computeCost(inputTokens, outputTokens);

    if (inputTokens > 0 || outputTokens > 0) {
      fetch("/api/cost-tracking/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: "options",
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          cost_usd: totalCost,
          model: selectedModel,
          scenario: context.scenario,
        }),
      }).catch((e) => console.error("[CostTracking] Failed to record options costs:", e));
    }

    const normalized = parsed.options.map((opt) => ({
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
    }));

    const options = distributeOptionCost(normalized, totalCost, outputTokens);

    return {
      options,
      selected_option: String(parsed.selected_option || "option_a"),
      selection_reason: String(parsed.selection_reason || "Best balance of risk and effectiveness."),
      source: "gemini",
      usageMetadata: {
        inputTokens,
        outputTokens,
        cost: totalCost,
      },
      model: selectedModel,
      reason: "ok",
    };
  } catch {
    return {
      ...fallbackMultiOptions({ scenario: context.scenario, rootCause, affectedPods: affectedCount }),
      reason: "request_error",
    };
  }
}
