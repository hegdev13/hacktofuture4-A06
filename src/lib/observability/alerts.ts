import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { publishObservabilityEvent } from "@/lib/observability/events";

type RuleRow = {
  endpoint_id: string;
  rule_key: string;
  metric_name: string;
  aggregation: "avg" | "sum" | "min" | "max" | "rate";
  threshold: number;
  duration_seconds: number;
  severity: "low" | "medium" | "high";
  enabled: boolean;
};

type StateRow = {
  rule_key: string;
  state: "pending" | "firing" | "resolved";
  state_since: string;
};

function toIso(input?: string, fallback = new Date().toISOString()) {
  if (!input) return fallback;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString();
}

export async function evaluateAlertRules(endpointId: string) {
  const admin = createSupabaseAdminClient();

  const [{ data: rulesData, error: rulesErr }, { data: latestRollup, error: rollupErr }] = await Promise.all([
    admin
      .from("alert_rules")
      .select("endpoint_id,rule_key,metric_name,aggregation,threshold,duration_seconds,severity,enabled")
      .eq("endpoint_id", endpointId)
      .eq("enabled", true),
    admin
      .from("metrics_rollups")
      .select("bucket_start,avg_cpu,avg_memory,restart_rate,pod_failed,pod_pending,pod_running")
      .eq("endpoint_id", endpointId)
      .eq("scope", "cluster")
      .order("bucket_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (rulesErr) throw new Error(rulesErr.message);
  if (rollupErr) throw new Error(rollupErr.message);

  const rules = (rulesData ?? []) as RuleRow[];
  const metricValues: Record<string, number> = {
    cpu_usage: Number(latestRollup?.avg_cpu ?? 0),
    memory_usage: Number(latestRollup?.avg_memory ?? 0),
    restart_count: Number(latestRollup?.restart_rate ?? 0),
    pod_failed: Number(latestRollup?.pod_failed ?? 0),
    pod_pending: Number(latestRollup?.pod_pending ?? 0),
    pod_running: Number(latestRollup?.pod_running ?? 0),
  };

  const { data: statesData, error: stateErr } = await admin
    .from("alert_states")
    .select("rule_key,state,state_since")
    .eq("endpoint_id", endpointId);

  if (stateErr) throw new Error(stateErr.message);
  const stateMap = new Map<string, StateRow>((statesData ?? []).map((s) => [s.rule_key, s as StateRow]));

  const transitions: Array<{ rule_key: string; state: "pending" | "firing" | "resolved"; value: number; message: string }> = [];

  const now = Date.now();
  for (const rule of rules) {
    const currentValue = Number(metricValues[rule.metric_name] ?? 0);
    const violated = currentValue > rule.threshold;
    const existing = stateMap.get(rule.rule_key);

    if (!existing && violated) {
      transitions.push({
        rule_key: rule.rule_key,
        state: "pending",
        value: currentValue,
        message: `${rule.rule_key} pending: ${currentValue.toFixed(4)} > ${rule.threshold}`,
      });
      continue;
    }

    if (!existing) continue;

    const stateSince = Date.parse(existing.state_since);
    const elapsedSec = Number.isNaN(stateSince) ? 0 : Math.max(0, Math.floor((now - stateSince) / 1000));

    if (violated) {
      if (existing.state === "pending" && elapsedSec >= rule.duration_seconds) {
        transitions.push({
          rule_key: rule.rule_key,
          state: "firing",
          value: currentValue,
          message: `${rule.rule_key} firing: threshold exceeded for ${elapsedSec}s`,
        });
      }
    } else if (existing.state === "pending" || existing.state === "firing") {
      transitions.push({
        rule_key: rule.rule_key,
        state: "resolved",
        value: currentValue,
        message: `${rule.rule_key} resolved: ${currentValue.toFixed(4)} <= ${rule.threshold}`,
      });
    }
  }

  for (const t of transitions) {
    const stateSince = toIso();

    const { error: upsertErr } = await admin.from("alert_states").upsert(
      {
        endpoint_id: endpointId,
        rule_key: t.rule_key,
        state: t.state,
        state_since: stateSince,
        last_value: t.value,
        updated_at: stateSince,
      },
      { onConflict: "endpoint_id,rule_key" },
    );
    if (upsertErr) throw new Error(upsertErr.message);

    const { error: histErr } = await admin.from("alert_state_history").insert({
      endpoint_id: endpointId,
      rule_key: t.rule_key,
      state: t.state,
      value: t.value,
      message: t.message,
      timestamp: stateSince,
    });
    if (histErr) throw new Error(histErr.message);

    if (t.state === "firing" || t.state === "resolved") {
      const sev = rules.find((r) => r.rule_key === t.rule_key)?.severity ?? "medium";
      const { error: alertErr } = await admin.from("alerts").insert({
        endpoint_id: endpointId,
        message: t.message,
        severity: sev,
        created_at: stateSince,
      });
      if (alertErr) throw new Error(alertErr.message);
    }

    await publishObservabilityEvent({
      endpoint_id: endpointId,
      event_type: "alert",
      severity: t.state === "firing" ? "critical" : t.state === "pending" ? "warning" : "info",
      title: t.message,
      details: {
        rule_key: t.rule_key,
        state: t.state,
        value: t.value,
      },
      timestamp: stateSince,
    });
  }

  return {
    ok: true,
    evaluatedRules: rules.length,
    transitions,
    metrics: metricValues,
  };
}
