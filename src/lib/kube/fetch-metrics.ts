import { z } from "zod";
import type { ClusterSnapshot } from "./types";

const PodSchema = z.object({
  pod_name: z.string().min(1),
  namespace: z.string().min(1).optional(),
  status: z.string().min(1),
  cpu_usage: z.number().nullable().optional(),
  memory_usage: z.number().nullable().optional(),
  restart_count: z.number().int().nullable().optional(),
});

const SnapshotSchema = z.object({
  pods: z.array(PodSchema),
  fetched_at: z.string().optional(),
});

function joinUrl(base: string, path: string) {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

async function tryFetchJson(url: string, signal: AbortSignal) {
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Upstream ${res.status} for ${url}`);
  return res.json();
}

const CANDIDATE_PATHS = [
  "/kubepulse/metrics",
  "/api/kubepulse/metrics",
  "/api/metrics",
  "/metrics",
  "/kube/metrics",
  "/api/kube/metrics",
];

export async function fetchClusterSnapshot(ngrokUrl: string): Promise<ClusterSnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const errors: string[] = [];

    for (const path of CANDIDATE_PATHS) {
      const url = joinUrl(ngrokUrl, path);
      try {
        const json = await tryFetchJson(url, controller.signal);
        const parsed = SnapshotSchema.safeParse(json);
        if (parsed.success) return parsed.data;
        errors.push(`Invalid shape at ${path}`);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    throw new Error(
      `Could not fetch metrics from upstream. Tried ${CANDIDATE_PATHS.join(
        ", ",
      )}. Last errors: ${errors.slice(-3).join(" | ")}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

