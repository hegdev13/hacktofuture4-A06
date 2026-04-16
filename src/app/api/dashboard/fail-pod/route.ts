import { spawnSync } from "node:child_process";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const BodySchema = z.object({
  podName: z.string().min(1),
  namespace: z.string().min(1).default("default"),
});

type KubectlResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
};

function runKubectl(args: string[]): KubectlResult {
  const run = spawnSync("kubectl", args, { encoding: "utf-8" });
  return {
    ok: run.status === 0,
    stdout: run.stdout || "",
    stderr: run.stderr || "",
    status: run.status,
  };
}

function parseOwner(stdout: string): { kind: string; name: string } | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  const [kindRaw, nameRaw] = trimmed.split("|");
  const kind = (kindRaw || "").trim();
  const name = (nameRaw || "").trim();
  if (!kind || !name) {
    return null;
  }
  return { kind, name };
}

function queryOwner(namespace: string, resourceType: string, resourceName: string) {
  return runKubectl([
    "get",
    resourceType,
    resourceName,
    "-n",
    namespace,
    "-o",
    "jsonpath={.metadata.ownerReferences[0].kind}|{.metadata.ownerReferences[0].name}",
  ]);
}

function resolveScaleTarget(namespace: string, podName: string): { resourceType: string; resourceName: string } | null {
  const podOwnerRes = queryOwner(namespace, "pod", podName);
  if (!podOwnerRes.ok) {
    return null;
  }

  const podOwner = parseOwner(podOwnerRes.stdout);
  if (!podOwner) {
    return null;
  }

  if (podOwner.kind === "Deployment") {
    return { resourceType: "deployment", resourceName: podOwner.name };
  }
  if (podOwner.kind === "StatefulSet") {
    return { resourceType: "statefulset", resourceName: podOwner.name };
  }
  if (podOwner.kind === "ReplicaSet") {
    const rsOwnerRes = queryOwner(namespace, "rs", podOwner.name);
    if (!rsOwnerRes.ok) {
      return { resourceType: "rs", resourceName: podOwner.name };
    }

    const rsOwner = parseOwner(rsOwnerRes.stdout);
    if (!rsOwner) {
      return { resourceType: "rs", resourceName: podOwner.name };
    }

    if (rsOwner.kind === "Deployment") {
      return { resourceType: "deployment", resourceName: rsOwner.name };
    }

    return { resourceType: "rs", resourceName: podOwner.name };
  }

  return null;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const { podName, namespace } = parsed.data;
  const target = resolveScaleTarget(namespace, podName);

  if (target) {
    const scaleRes = runKubectl([
      "scale",
      `${target.resourceType}/${target.resourceName}`,
      "-n",
      namespace,
      "--replicas=0",
    ]);

    if (!scaleRes.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: scaleRes.stderr || `Failed to scale ${target.resourceType}/${target.resourceName}`,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      action: "scaled_to_zero",
      targetKind: target.resourceType,
      targetName: target.resourceName,
      namespace,
      message: `Scaled ${target.resourceType}/${target.resourceName} to 0 replicas.`,
      output: scaleRes.stdout,
    });
  }

  const deleteRes = runKubectl(["delete", "pod", podName, "-n", namespace, "--force", "--grace-period=0"]);
  if (!deleteRes.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: deleteRes.stderr || `Failed to delete pod ${namespace}/${podName}`,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    action: "pod_deleted",
    targetKind: "pod",
    targetName: podName,
    namespace,
    warning: "Pod was deleted directly. If managed by a controller, it may restart automatically.",
    output: deleteRes.stdout,
  });
}
