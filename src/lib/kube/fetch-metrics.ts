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

function parseSnapshotJson(json: unknown): ClusterSnapshot | null {
  const parsed = SnapshotSchema.safeParse(json);
  if (parsed.success) return parsed.data;

  const podsParsed = PodsListSchema.safeParse(json);
  if (podsParsed.success) return snapshotFromPodsList(podsParsed.data);

  return null;
}

function joinUrl(base: string, path: string) {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

function normalizeNgrokBase(input: string) {
  const u = new URL(input);
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const stripIfExact = new Set([
    "/pods",
    "/api/pods",
    "/metrics",
    "/api/metrics",
    "/kubepulse/metrics",
    "/api/kubepulse/metrics",
    "/kube/metrics",
    "/api/kube/metrics",
  ]);

  if (stripIfExact.has(path)) {
    u.pathname = "/";
    u.search = "";
    u.hash = "";
  }

  return u.toString().replace(/\/+$/, "");
}

async function tryFetchJson(url: string, signal: AbortSignal) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "ngrok-skip-browser-warning": "1",
    },
    signal,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Upstream ${res.status} for ${url}`);
  return res.json();
}

const PodsListSchema = z.object({
  count: z.number().optional(),
  pods: z.array(
    z.object({
      name: z.string().min(1).optional(),
      namespace: z.string().min(1).optional(),
      status: z.string().min(1).optional(),
      phase: z.string().min(1).optional(),
      restart_count: z.number().int().optional(),
      ready: z.boolean().optional(),
      cpu_usage: z.number().nullable().optional(),
      memory_usage: z.number().nullable().optional(),
    }).passthrough(),
  ),
});

function snapshotFromPodsList(
  data: z.infer<typeof PodsListSchema>,
): ClusterSnapshot {
  const normalized = data.pods
    .map((p) => {
      const podName = typeof p.name === "string" && p.name.length > 0 ? p.name : null;
      const status =
        (typeof p.status === "string" && p.status.length > 0
          ? p.status
          : typeof p.phase === "string" && p.phase.length > 0
            ? p.phase
            : null) ?? null;

      if (!podName || !status) return null;
      return {
        pod_name: podName,
        namespace: p.namespace ?? "default",
        status,
        cpu_usage: p.cpu_usage ?? null,
        memory_usage: p.memory_usage ?? null,
        restart_count: p.restart_count ?? 0,
      };
    })
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  return {
    pods: normalized,
    fetched_at: new Date().toISOString(),
  };
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
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const normalizedBase = normalizeNgrokBase(ngrokUrl);
    const errors: string[] = [];

    // If the user pasted a full endpoint like /pods?include_logs=true&log_tail=20,
    // try that exact URL first before probing fallback paths.
    try {
      const directJson = await tryFetchJson(ngrokUrl, controller.signal);
      const directParsed = parseSnapshotJson(directJson);
      if (directParsed) return directParsed;
      errors.push("Invalid shape at direct URL");
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }

    for (const path of CANDIDATE_PATHS) {
      const url = joinUrl(normalizedBase, path);
      try {
        const json = await tryFetchJson(url, controller.signal);
        const parsed = parseSnapshotJson(json);
        if (parsed) return parsed;
        errors.push(`Invalid shape at ${path}`);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    for (const path of ["/pods", "/api/pods"]) {
      const url = joinUrl(normalizedBase, path);
      try {
        const json = await tryFetchJson(url, controller.signal);
        const parsed = parseSnapshotJson(json);
        if (parsed) return parsed;
        errors.push(`Invalid pods shape at ${path}`);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    throw new Error(
      `Could not fetch metrics from upstream. Tried ${CANDIDATE_PATHS.join(
        ", ",
      )}, /pods, /api/pods. Last errors: ${errors.slice(-4).join(" | ")}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

