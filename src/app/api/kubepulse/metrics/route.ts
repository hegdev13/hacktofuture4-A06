import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type KubePodItem = {
  metadata?: {
    name?: string;
    namespace?: string;
  };
  status?: {
    phase?: string;
    reason?: string;
    containerStatuses?: Array<{
      restartCount?: number;
      state?: {
        waiting?: {
          reason?: string;
        };
        terminated?: {
          reason?: string;
          exitCode?: number;
        };
      };
    }>;
    initContainerStatuses?: Array<{
      state?: {
        waiting?: {
          reason?: string;
        };
      };
    }>;
  };
};

type KubePodsResponse = {
  items?: KubePodItem[];
};

const FAILING_WAITING_REASONS = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "CrashLoopBackOff",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
  "InvalidImageName",
]);

function computeDisplayStatus(item: KubePodItem): string {
  const phase = item.status?.phase ?? "Unknown";
  if (phase === "Failed") return "Failed";

  const containerStatuses = item.status?.containerStatuses ?? [];
  for (const s of containerStatuses) {
    const waitingReason = s.state?.waiting?.reason;
    if (waitingReason && FAILING_WAITING_REASONS.has(waitingReason)) {
      return "Failed";
    }
    const terminatedReason = s.state?.terminated?.reason;
    const exitCode = s.state?.terminated?.exitCode;
    if (terminatedReason === "OOMKilled" || (typeof exitCode === "number" && exitCode !== 0)) {
      return "Failed";
    }
  }

  const initStatuses = item.status?.initContainerStatuses ?? [];
  for (const s of initStatuses) {
    const waitingReason = s.state?.waiting?.reason;
    if (waitingReason && FAILING_WAITING_REASONS.has(waitingReason)) {
      return "Failed";
    }
  }

  return phase;
}

function computeFailureReason(item: KubePodItem): string | null {
  const containerStatuses = item.status?.containerStatuses ?? [];
  for (const s of containerStatuses) {
    const waitingReason = s.state?.waiting?.reason;
    if (waitingReason) return waitingReason;
    const terminatedReason = s.state?.terminated?.reason;
    if (terminatedReason) return terminatedReason;
  }

  const initStatuses = item.status?.initContainerStatuses ?? [];
  for (const s of initStatuses) {
    const waitingReason = s.state?.waiting?.reason;
    if (waitingReason) return waitingReason;
  }

  return item.status?.reason ?? null;
}

function coerceNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCpuToMillicores(cpuRaw: string): number | null {
  const v = cpuRaw.trim();
  if (!v) return null;
  if (v.endsWith("m")) return coerceNumber(v.slice(0, -1));
  const cores = coerceNumber(v);
  return cores === null ? null : cores * 1000;
}

function parseMemoryToMi(memoryRaw: string): number | null {
  const v = memoryRaw.trim();
  if (!v) return null;
  if (v.endsWith("Ki")) {
    const n = coerceNumber(v.slice(0, -2));
    return n === null ? null : n / 1024;
  }
  if (v.endsWith("Mi")) return coerceNumber(v.slice(0, -2));
  if (v.endsWith("Gi")) {
    const n = coerceNumber(v.slice(0, -2));
    return n === null ? null : n * 1024;
  }
  return coerceNumber(v);
}

async function getTopPodMetrics(): Promise<Map<string, { cpu: number | null; memory: number | null }>> {
  const out = new Map<string, { cpu: number | null; memory: number | null }>();

  try {
    const { stdout } = await execFileAsync("kubectl", ["top", "pods", "-A", "--no-headers"], {
      timeout: 8000,
      maxBuffer: 1024 * 1024,
    });

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 4) continue;

      const namespace = parts[0];
      const name = parts[1];
      const cpu = parseCpuToMillicores(parts[2]);
      const memory = parseMemoryToMi(parts[3]);
      out.set(`${namespace}/${name}`, { cpu, memory });
    }
  } catch {
    // "kubectl top" requires metrics-server. If unavailable, return without cpu/memory metrics.
  }

  return out;
}

export async function GET() {
  try {
    const [{ stdout }, topMetrics] = await Promise.all([
      execFileAsync("kubectl", ["get", "pods", "-A", "-o", "json"], {
        timeout: 10000,
        maxBuffer: 8 * 1024 * 1024,
      }),
      getTopPodMetrics(),
    ]);

    const parsed = JSON.parse(stdout) as KubePodsResponse;
    const items = Array.isArray(parsed.items) ? parsed.items : [];

    const pods = items
      .map((item) => {
        const namespace = item.metadata?.namespace;
        const podName = item.metadata?.name;
        const status = computeDisplayStatus(item);
        if (!namespace || !podName || !status) return null;

        const restarts = (item.status?.containerStatuses ?? []).reduce(
          (sum, c) => sum + (c.restartCount ?? 0),
          0,
        );
        const reason = computeFailureReason(item);

        const top = topMetrics.get(`${namespace}/${podName}`);

        return {
          pod_name: podName,
          namespace,
          status,
          reason,
          cpu_usage: top?.cpu ?? null,
          memory_usage: top?.memory ?? null,
          restart_count: restarts,
        };
      })
      .filter((p): p is NonNullable<typeof p> => Boolean(p));

    return NextResponse.json({
      pods,
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "kubernetes_unavailable",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
