import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { LogEntryInput } from "@/lib/observability/types";

function toIso(input?: string, fallback = new Date().toISOString()) {
  if (!input) return fallback;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString();
}

export async function ingestLogs(entries: LogEntryInput[]) {
  if (!entries.length) return { inserted: 0 };
  const admin = createSupabaseAdminClient();

  const rows = entries.map((e) => ({
    endpoint_id: e.endpoint_id ?? null,
    timestamp: toIso(e.timestamp),
    labels: e.labels,
    message: e.message,
    source: e.source ?? "pod",
    level: e.level ?? "info",
    correlation_id: e.correlation_id ?? null,
  }));

  const { error } = await admin.from("logs_entries").insert(rows);
  if (error) throw new Error(error.message);
  return { inserted: rows.length };
}

export async function queryLogs(input: {
  endpoint_id?: string;
  namespace?: string;
  pod?: string;
  node?: string;
  container?: string;
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
}) {
  const admin = createSupabaseAdminClient();
  const from = toIso(input.from, new Date(Date.now() - 30 * 60_000).toISOString());
  const to = toIso(input.to);
  const limit = Math.min(2000, Math.max(1, input.limit ?? 300));

  let query = admin
    .from("logs_entries")
    .select("id,endpoint_id,timestamp,labels,message,source,level,correlation_id")
    .gte("timestamp", from)
    .lte("timestamp", to)
    .order("timestamp", { ascending: false })
    .limit(limit);

  if (input.endpoint_id) query = query.eq("endpoint_id", input.endpoint_id);
  if (input.namespace) query = query.filter("labels->>namespace", "eq", input.namespace);
  if (input.pod) query = query.filter("labels->>pod", "eq", input.pod);
  if (input.node) query = query.filter("labels->>node", "eq", input.node);
  if (input.container) query = query.filter("labels->>container", "eq", input.container);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  let out = (data ?? []) as Array<{
    id: string;
    endpoint_id: string | null;
    timestamp: string;
    labels: Record<string, string>;
    message: string;
    source: string;
    level: string;
    correlation_id: string | null;
  }>;

  if (input.search) {
    const needle = input.search.toLowerCase();
    out = out.filter((row) => row.message.toLowerCase().includes(needle));
  }

  return {
    range: { from, to },
    total: out.length,
    logs: out,
  };
}
