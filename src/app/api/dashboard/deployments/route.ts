import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

const PROTECTED_NAMESPACES = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "local-path-storage",
  "ingress-nginx",
  "cert-manager",
  "monitoring",
]);

type KubeDeploymentItem = {
  metadata?: {
    name?: string;
    namespace?: string;
  };
  spec?: {
    replicas?: number;
  };
  status?: {
    readyReplicas?: number;
    unavailableReplicas?: number;
  };
};

type KubeDeploymentResponse = {
  items?: KubeDeploymentItem[];
};

export async function GET() {
  try {
    const { stdout } = await execFileAsync("kubectl", ["get", "deploy", "-A", "-o", "json"], {
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    });

    const parsed = JSON.parse(stdout) as KubeDeploymentResponse;
    const items = Array.isArray(parsed.items) ? parsed.items : [];

    const deployments = items
      .map((item) => {
        const namespace = item.metadata?.namespace;
        const name = item.metadata?.name;
        if (!namespace || !name) return null;
        if (PROTECTED_NAMESPACES.has(namespace)) return null;

        const replicas = typeof item.spec?.replicas === "number" ? item.spec.replicas : 1;
        const readyReplicas = typeof item.status?.readyReplicas === "number" ? item.status.readyReplicas : 0;
        const unavailableReplicas = typeof item.status?.unavailableReplicas === "number" ? item.status.unavailableReplicas : 0;

        let status = "Running";
        if (replicas === 0) status = "Failed";
        else if (readyReplicas < replicas || unavailableReplicas > 0) status = "Pending";

        return {
          pod_name: name,
          namespace,
          status,
          cpu_usage: null,
          memory_usage: null,
          restart_count: 0,
          kind: "deployment" as const,
          replicas,
          ready_replicas: readyReplicas,
        };
      })
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.pod_name.localeCompare(b.pod_name));

    return NextResponse.json({
      ok: true,
      deployments,
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: "failed_to_list_deployments",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
