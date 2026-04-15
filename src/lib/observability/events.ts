import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { ObservabilityEventInput } from "@/lib/observability/types";

function toIso(input?: string, fallback = new Date().toISOString()) {
  if (!input) return fallback;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString();
}

export async function publishObservabilityEvent(input: ObservabilityEventInput) {
  const admin = createSupabaseAdminClient();
  const row = {
    endpoint_id: input.endpoint_id ?? null,
    correlation_id: input.correlation_id ?? null,
    event_type: input.event_type,
    related_resource: input.related_resource ?? null,
    related_kind: input.related_kind ?? null,
    severity: input.severity ?? "info",
    title: input.title,
    details: input.details ?? {},
    timestamp: toIso(input.timestamp),
  };

  const { error } = await admin.from("observability_events").insert(row);
  if (error) throw new Error(error.message);
}

export async function getTimeline(input: {
  endpoint_id?: string;
  issue_id?: string;
  from?: string;
  to?: string;
  types?: string[];
  limit?: number;
}) {
  const admin = createSupabaseAdminClient();
  const from = toIso(input.from, new Date(Date.now() - 60 * 60_000).toISOString());
  const to = toIso(input.to);
  const limit = Math.min(2000, Math.max(1, input.limit ?? 400));

  let query = admin
    .from("observability_events")
    .select("id,endpoint_id,correlation_id,event_type,related_resource,related_kind,severity,title,details,timestamp")
    .gte("timestamp", from)
    .lte("timestamp", to)
    .order("timestamp", { ascending: false })
    .limit(limit);

  if (input.endpoint_id) {
    query = query.eq("endpoint_id", input.endpoint_id);
  }
  if (input.issue_id) {
    query = query.eq("correlation_id", input.issue_id);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  let events = (data ?? []) as Array<Record<string, unknown>>;
  if (input.types?.length) {
    const allowed = new Set(input.types);
    events = events.filter((e) => {
      const t = typeof e.event_type === "string" ? e.event_type : "";
      return allowed.has(t);
    });
  }

  return {
    range: { from, to },
    total: events.length,
    events,
  };
}

export async function upsertIssueLifecycle(input: {
  endpoint_id?: string;
  issue_id: string;
  title: string;
  status: string;
  detected_at?: string;
  analysis_started_at?: string;
  fix_applied_at?: string;
  resolved_at?: string;
  failed_at?: string;
}) {
  const admin = createSupabaseAdminClient();

  const row = {
    endpoint_id: input.endpoint_id ?? null,
    issue_id: input.issue_id,
    title: input.title,
    status: input.status,
    detected_at: input.detected_at ?? null,
    analysis_started_at: input.analysis_started_at ?? null,
    fix_applied_at: input.fix_applied_at ?? null,
    resolved_at: input.resolved_at ?? null,
    failed_at: input.failed_at ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await admin.from("issue_lifecycles").upsert(row, {
    onConflict: "endpoint_id,issue_id",
  });
  if (error) throw new Error(error.message);
}
