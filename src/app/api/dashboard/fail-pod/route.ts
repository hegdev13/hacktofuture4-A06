import { spawnSync } from "node:child_process";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const PROTECTED_NAMESPACES = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "local-path-storage",
  "ingress-nginx",
  "cert-manager",
  "monitoring",
]);

const BodySchema = z.object({
  podName: z.string().min(1),
  namespace: z.string().min(1).default("default"),
  mode: z.enum(["auto", "delete", "scale_to_zero"]).optional(),
});

const LOAD_SPIKE_NAMESPACES = new Set([
  "ad",
  "cart",
  "checkout",
  "currency",
  "email",
  "frontend",
  "payment",
  "product-catalog",
  "recommendation",
  "shipping",
]);

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

function isNotFound(stderr: string) {
  const s = stderr.toLowerCase();
  return s.includes("notfound") || s.includes("not found");
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
      return null;
    }

    const rsOwner = parseOwner(rsOwnerRes.stdout);
    if (!rsOwner) {
      return null;
    }

    if (rsOwner.kind === "Deployment") {
      return { resourceType: "deployment", resourceName: rsOwner.name };
    }

    return null;
  }

  return null;
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function chooseAutoStrategy(namespace: string, serviceName: string, hasScaleTarget: boolean) {
  const pool: Array<"delete" | "scale_to_zero" | "load_spike_and_crash"> = ["delete"];
  if (hasScaleTarget) {
    pool.push("scale_to_zero");
  }
  if (LOAD_SPIKE_NAMESPACES.has(namespace)) {
    pool.push("load_spike_and_crash");
  }

  const seed = `${namespace}/${serviceName}`;
  const pick = pool[hashString(seed) % pool.length];
  return pick;
}

function applyLoadSpike(users: number) {
  const exists = runKubectl(["get", "deployment", "loadgenerator", "-n", "loadgenerator", "-o", "name"]);
  if (!exists.ok) {
    return { ok: false, reason: "loadgenerator_missing" };
  }

  const setEnv = runKubectl([
    "set",
    "env",
    "deployment/loadgenerator",
    "-n",
    "loadgenerator",
    `USERS=${String(users)}`,
  ]);
  if (!setEnv.ok) {
    return { ok: false, reason: setEnv.stderr || "loadgenerator_env_update_failed" };
  }

  const restart = runKubectl(["rollout", "restart", "deployment/loadgenerator", "-n", "loadgenerator"]);
  if (!restart.ok) {
    return { ok: false, reason: restart.stderr || "loadgenerator_restart_failed" };
  }

  const rollout = runKubectl(["rollout", "status", "deployment/loadgenerator", "-n", "loadgenerator", "--timeout=45s"]);
  return {
    ok: rollout.ok,
    reason: rollout.ok ? "load_spike_applied" : rollout.stderr || "loadgenerator_rollout_timeout",
  };
}

function scaleTargetToZero(target: { resourceType: string; resourceName: string }, namespace: string) {
  return runKubectl([
    "scale",
    `${target.resourceType}/${target.resourceName}`,
    "-n",
    namespace,
    "--replicas=0",
  ]);
}

function deletePodNow(podName: string, namespace: string) {
  return runKubectl([
    "delete",
    "pod",
    podName,
    "-n",
    namespace,
    "--grace-period=0",
    "--force",
  ]);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const { podName, namespace, mode = "auto" } = parsed.data;
  if (PROTECTED_NAMESPACES.has(namespace)) {
    return NextResponse.json(
      {
        ok: false,
        error: "protected_namespace_not_supported",
      },
      { status: 400 },
    );
  }

  const podCheck = runKubectl(["get", "pod", podName, "-n", namespace, "-o", "name"]);
  if (!podCheck.ok) {
    if (isNotFound(podCheck.stderr)) {
      return NextResponse.json({
        ok: true,
        action: "already_missing",
        namespace,
        podName,
        message: `Pod ${namespace}/${podName} is already missing.`,
      });
    }

    return NextResponse.json(
      {
        ok: false,
        error: podCheck.stderr || "failed_to_query_pod",
      },
      { status: 500 },
    );
  }

  const target = resolveScaleTarget(namespace, podName);
  const serviceName = target?.resourceName || podName;

  const effectiveMode =
    mode === "auto"
      ? chooseAutoStrategy(namespace, serviceName, Boolean(target))
      : mode;

  if (target && effectiveMode === "scale_to_zero") {
    const scaleRes = scaleTargetToZero(target, namespace);

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
      strategy: effectiveMode,
      targetKind: target.resourceType,
      targetName: target.resourceName,
      namespace,
      message: `Scaled ${target.resourceType}/${target.resourceName} to 0 replicas.`,
      output: scaleRes.stdout,
    });
  }

  if (effectiveMode === "load_spike_and_crash") {
    const users = 120 + (hashString(`${namespace}/${podName}`) % 60);
    const loadSpike = applyLoadSpike(users);

    const deleteRes = deletePodNow(podName, namespace);
    if (deleteRes.ok || isNotFound(deleteRes.stderr)) {
      return NextResponse.json({
        ok: true,
        action: "load_spike_and_crash",
        strategy: effectiveMode,
        namespace,
        podName,
        users,
        message: `Injected load spike (USERS=${users}) and crashed ${namespace}/${podName}.`,
        details: loadSpike,
      });
    }

    return NextResponse.json(
      {
        ok: false,
        error: deleteRes.stderr || "failed_after_load_spike",
      },
      { status: 409 },
    );
  }

  const deleteRes = deletePodNow(podName, namespace);

  if (deleteRes.ok || isNotFound(deleteRes.stderr)) {
    return NextResponse.json({
      ok: true,
      action: deleteRes.ok ? "deleted_pod" : "already_missing",
      strategy: effectiveMode,
      namespace,
      podName,
      message: deleteRes.ok
        ? `Deleted pod ${namespace}/${podName}.`
        : `Pod ${namespace}/${podName} is already missing.`,
      output: deleteRes.stdout,
    });
  }

  return NextResponse.json(
    {
      ok: false,
      error: deleteRes.stderr || "unsupported_workload_for_scale_to_zero",
    },
    { status: 409 },
  );
}
