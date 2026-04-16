import "server-only";

import type { AgentRunnerStatus, HealingSummary, StructuredHealingLog } from "@/lib/healing/types";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

function fallbackSummary(logs: StructuredHealingLog[], status: AgentRunnerStatus): HealingSummary {
  const last = logs.at(-1);
  const groupedByIssue = new Map<string, StructuredHealingLog[]>();
  for (const log of logs) {
    const arr = groupedByIssue.get(log.issue_id) || [];
    arr.push(log);
    groupedByIssue.set(log.issue_id, arr);
  }

  const explanations = Array.from(groupedByIssue.entries()).map(([issueId, issueLogs]) => {
    const events = issueLogs.map((l) => l.event_type).join(" -> ");
    return {
      issue_id: issueId,
      explanation: `Issue ${issueId} followed lifecycle ${events}.`,
    };
  });

  return {
    what_happened: logs.length
      ? `${logs.length} structured healing events were recorded across ${groupedByIssue.size} issue(s).`
      : "No healing events captured yet.",
    actions_taken: logs
      .filter((l) => l.event_type === "FIXING")
      .map((l) => `${l.agent_name}: ${l.action_taken}`)
      .join("; ") || "No corrective actions executed yet.",
    final_outcome: status.state === "completed"
      ? "Self-healing run completed successfully."
      : status.state === "failed"
        ? `Self-healing run failed${status.lastError ? `: ${status.lastError}` : "."}`
        : "Self-healing run is in progress.",
    decision_trace: last
      ? `Latest decision by ${last.agent_name}: ${last.description}`
      : "No decisions recorded yet.",
    log_explanations: explanations,
  };
}

function parseJson<T>(raw: string): T | null {
  const text = String(raw || "").trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}

export async function generateGeminiHealingSummary(
  logs: StructuredHealingLog[],
  status: AgentRunnerStatus,
): Promise<HealingSummary> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fallbackSummary(logs, status);

  const compactLogs = logs.slice(-120).map((l) => ({
    timestamp: l.timestamp,
    agent_name: l.agent_name,
    event_type: l.event_type,
    issue_id: l.issue_id,
    description: l.description,
    action_taken: l.action_taken,
    status: l.status,
    confidence: l.confidence,
  }));

  const prompt = [
    "You are an SRE incident analyst.",
    "Summarize this AI self-healing run in concise, operator-friendly language.",
    "Return STRICT JSON only with this schema:",
    "{",
    '  "what_happened": "string",',
    '  "actions_taken": "string",',
    '  "final_outcome": "string",',
    '  "decision_trace": "string",',
    '  "log_explanations": [{"issue_id":"string","explanation":"string"}]',
    "}",
    `Run status: ${JSON.stringify(status)}`,
    `Logs: ${JSON.stringify(compactLogs)}`,
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
          maxOutputTokens: 900,
        },
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      return fallbackSummary(logs, { ...status, lastError: `Gemini API ${response.status}` });
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

      // Capture token usage metadata
      const usageMetadata = (data as any)?.usageMetadata || {};
      const inputTokens = usageMetadata.promptTokenCount || 0;
      const outputTokens = usageMetadata.candidatesTokenCount || 0;
      const costUsd = (inputTokens / 1000000) * 0.075 + (outputTokens / 1000000) * 0.30;

      // Record cost asynchronously
      if (inputTokens > 0 || outputTokens > 0) {
        fetch("/api/cost-tracking/record", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stage: "summary",
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            cost_usd: costUsd,
            model: GEMINI_MODEL,
            scenario: status.scenario,
          }),
        }).catch((e) => console.error("[CostTracking] Failed to record summary costs:", e));
      }

    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") || "";
    const parsed = parseJson<HealingSummary>(text);
    if (!parsed) return fallbackSummary(logs, status);

    return {
      what_happened: parsed.what_happened || "",
      actions_taken: parsed.actions_taken || "",
      final_outcome: parsed.final_outcome || "",
      decision_trace: parsed.decision_trace || "",
      log_explanations: Array.isArray(parsed.log_explanations) ? parsed.log_explanations : [],
    };
  } catch {
    return fallbackSummary(logs, status);
  }
}
