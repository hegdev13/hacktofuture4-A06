import { spawnSync } from "node:child_process";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const FailureTypeSchema = z.enum([
  "scaled_to_zero",
  "crash_app",
  "image_pull_error",
  "oom_kill",
  "dependency_break",
  "probe_failure",
]);

const BodySchema = z.object({
  failure_type: FailureTypeSchema.optional(),
  failureType: FailureTypeSchema.optional(),
  target_name: z.string().min(1).optional(),
  targetName: z.string().min(1).optional(),
  podName: z.string().min(1).optional(),
  namespace: z.string().min(1).default("default"),
});

type KubectlResult = {
  command: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
};

function runKubectl(args: string[]): KubectlResult {
  const run = spawnSync("kubectl", args, { encoding: "utf-8" });
  return {
    command: `kubectl ${args.join(" ")}`,
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

function resolveWorkloadTarget(namespace: string, podName: string): { resourceType: string; resourceName: string } | null {
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

function kubectlExists(resourceType: string, name: string, namespace: string): boolean {
  const res = runKubectl(["get", resourceType, name, "-n", namespace]);
  return res.ok;
}

function resolveDeploymentName(namespace: string, targetName: string): string | null {
  if (kubectlExists("deployment", targetName, namespace)) {
    return targetName;
  }

  if (kubectlExists("pod", targetName, namespace)) {
    const target = resolveWorkloadTarget(namespace, targetName);
    if (target?.resourceType === "deployment") {
      return target.resourceName;
    }
  }

  // Fallback for common Deployment pod names: <deployment>-<rs-hash>-<pod-suffix>
  const parts = targetName.split("-");
  if (parts.length >= 3) {
    const inferred = parts.slice(0, -2).join("-");
    if (inferred && kubectlExists("deployment", inferred, namespace)) {
      return inferred;
    }
  }

  return null;
}

function firstPodForWorkload(namespace: string, workloadName: string): string | null {
  const pods = runKubectl(["get", "pods", "-n", namespace, "--no-headers"]);
  if (!pods.ok) {
    return null;
  }

  const lines = pods.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const match = lines.find((line) => line.startsWith(`${workloadName}-`));
  if (!match) {
    return null;
  }

  return match.split(/\s+/)[0] || null;
}

function firstContainerName(namespace: string, deploymentName: string): string | null {
  const res = runKubectl([
    "get",
    "deployment",
    deploymentName,
    "-n",
    namespace,
    "-o",
    "jsonpath={.spec.template.spec.containers[0].name}",
  ]);

  if (!res.ok) {
    return null;
  }

  const name = res.stdout.trim();
  return name || null;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const requestedFailureType = parsed.data.failure_type || parsed.data.failureType;
  const namespace = parsed.data.namespace;
  const targetName = (parsed.data.target_name || parsed.data.targetName || parsed.data.podName || "").trim();

  if (!targetName) {
    return NextResponse.json({ ok: false, error: "target_name_required" }, { status: 400 });
  }

  const commandsExecuted: KubectlResult[] = [];
  const errors: string[] = [];

  // STEP 1: validate target using real cluster state
  const prePods = runKubectl(["get", "pods", "-n", namespace]);
  commandsExecuted.push(prePods);
  if (!prePods.ok) {
    return NextResponse.json(
      {
        ok: false,
        "Failure Type Applied": failureType,
        "Target Resource": `${namespace}/${targetName}`,
        "Commands Executed": commandsExecuted,
        "Observed Pod State (REAL)": "unavailable",
        Errors: [prePods.stderr || "failed to list pods"],
        Confidence: "FAILED",
      },
      { status: 500 },
    );
  }

  let applyResult: KubectlResult | null = null;
  let targetResource = targetName;
  let affectedPod = "";
  let failureType = requestedFailureType as z.infer<typeof FailureTypeSchema> | undefined;
  const isPodTarget = kubectlExists("pod", targetName, namespace);
  const deploymentNameForTarget = resolveDeploymentName(namespace, targetName);

  if (!failureType) {
    if (deploymentNameForTarget) {
      failureType = "scaled_to_zero";
    } else {
      const options: Array<z.infer<typeof FailureTypeSchema>> = [
        "crash_app",
        "image_pull_error",
        "oom_kill",
        "probe_failure",
      ];

      if (kubectlExists("svc", targetName, namespace)) {
        options.push("dependency_break");
      }

      failureType = options[Math.floor(Math.random() * options.length)] || "crash_app";
    }
  }

  // STEP 2: apply actual failure based on type
  if (failureType === "scaled_to_zero") {
    const deploymentName = deploymentNameForTarget;
    if (!deploymentName) {
      return NextResponse.json(
        {
          ok: false,
          "Failure Type Applied": failureType,
          "Target Resource": `${namespace}/${targetName}`,
          "Commands Executed": commandsExecuted,
          "Observed Pod State (REAL)": prePods.stdout,
          Errors: [
            `target ${targetName} is not mapped to a deployment in namespace ${namespace}`,
          ],
          Confidence: "FAILED",
        },
        { status: 404 },
      );
    }

    applyResult = runKubectl(["scale", "deployment", deploymentName, "-n", namespace, "--replicas=0"]);
    commandsExecuted.push(applyResult);
    targetResource = `deployment/${deploymentName}`;
    affectedPod = firstPodForWorkload(namespace, deploymentName) || targetName;
  } else if (isPodTarget) {
    applyResult = runKubectl(["delete", "pod", targetName, "-n", namespace]);
    commandsExecuted.push(applyResult);
    targetResource = `pod/${targetName}`;

    const workloadTarget = resolveWorkloadTarget(namespace, targetName);
    if (workloadTarget) {
      affectedPod = firstPodForWorkload(namespace, workloadTarget.resourceName) || targetName;
    } else {
      affectedPod = targetName;
    }
  } else if (failureType === "dependency_break") {
    if (!kubectlExists("svc", targetName, namespace)) {
      return NextResponse.json(
        {
          ok: false,
          "Failure Type Applied": failureType,
          "Target Resource": `svc/${namespace}/${targetName}`,
          "Commands Executed": commandsExecuted,
          "Observed Pod State (REAL)": prePods.stdout,
          Errors: [`service ${targetName} not found in namespace ${namespace}`],
          Confidence: "FAILED",
        },
        { status: 404 },
      );
    }

    applyResult = runKubectl(["delete", "svc", targetName, "-n", namespace]);
    commandsExecuted.push(applyResult);
    targetResource = `svc/${targetName}`;
  } else {
    const deploymentName = resolveDeploymentName(namespace, targetName);
    if (!deploymentName) {
      return NextResponse.json(
        {
          ok: false,
          "Failure Type Applied": failureType,
          "Target Resource": `${namespace}/${targetName}`,
          "Commands Executed": commandsExecuted,
          "Observed Pod State (REAL)": prePods.stdout,
          Errors: [
            `target ${targetName} not found as deployment or pod with deployment owner in namespace ${namespace}`,
          ],
          Confidence: "FAILED",
        },
        { status: 404 },
      );
    }

    targetResource = `deployment/${deploymentName}`;

    if (failureType === "crash_app") {
      applyResult = runKubectl([
        "patch",
        "deployment",
        deploymentName,
        "-n",
        namespace,
        "--type=json",
        "-p",
        '[{"op":"replace","path":"/spec/template/spec/containers/0/command","value":["sh","-c","exit 1"]}]',
      ]);
      commandsExecuted.push(applyResult);
    } else if (failureType === "image_pull_error") {
      applyResult = runKubectl([
        "set",
        "image",
        `deployment/${deploymentName}`,
        "*=invalid-image:latest",
        "-n",
        namespace,
      ]);
      commandsExecuted.push(applyResult);
    } else if (failureType === "oom_kill") {
      const containerName = firstContainerName(namespace, deploymentName) || deploymentName;
      const patch = JSON.stringify({
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: containerName,
                  resources: { limits: { memory: "20Mi" } },
                },
              ],
            },
          },
        },
      });

      applyResult = runKubectl([
        "patch",
        "deployment",
        deploymentName,
        "-n",
        namespace,
        "-p",
        patch,
      ]);
      commandsExecuted.push(applyResult);
    } else if (failureType === "probe_failure") {
      const containerName = firstContainerName(namespace, deploymentName) || deploymentName;
      const patch = JSON.stringify({
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: containerName,
                  livenessProbe: {
                    httpGet: {
                      path: "/wrong",
                      port: 8080,
                    },
                  },
                },
              ],
            },
          },
        },
      });

      applyResult = runKubectl([
        "patch",
        "deployment",
        deploymentName,
        "-n",
        namespace,
        "-p",
        patch,
      ]);
      commandsExecuted.push(applyResult);
    }

    affectedPod = firstPodForWorkload(namespace, deploymentName) || "";
  }

  if (!applyResult || !applyResult.ok) {
    errors.push(applyResult?.stderr || "failure injection command failed");
  }

  // STEP 3: observe result from live cluster state
  const postPods = runKubectl(["get", "pods", "-n", namespace]);
  commandsExecuted.push(postPods);
  if (!postPods.ok) {
    errors.push(postPods.stderr || "failed to list pods after failure injection");
  }

  if (!affectedPod && kubectlExists("pod", targetName, namespace)) {
    affectedPod = targetName;
  }

  let describeResult: KubectlResult | null = null;
  if (affectedPod) {
    describeResult = runKubectl(["describe", "pod", affectedPod, "-n", namespace]);
    commandsExecuted.push(describeResult);
    if (!describeResult.ok) {
      errors.push(describeResult.stderr || `failed to describe pod ${affectedPod}`);
    }
  } else {
    errors.push("could not determine affected pod for describe");
  }

  const confidence = !applyResult || !applyResult.ok ? "FAILED" : errors.length ? "PARTIAL" : "REAL";
  const ok = confidence !== "FAILED";

  // Backward-compatible fields for existing dashboard button behavior
  const targetKind = targetResource.split("/")[0] || "resource";
  const targetNameOut = targetResource.split("/")[1] || targetName;

  return NextResponse.json(
    {
      ok,
      action: failureType,
      targetKind,
      targetName: targetNameOut,
      namespace,
      message: ok ? `Applied ${failureType} on ${targetResource}` : `Failed to apply ${failureType} on ${targetResource}`,
      "Failure Type Applied": failureType,
      "Target Resource": `${namespace}/${targetResource}`,
      "Commands Executed": commandsExecuted,
      "Observed Pod State (REAL)": {
        pods_before: prePods.stdout,
        pods_after: postPods.stdout,
        affected_pod: affectedPod || null,
        describe_output: describeResult?.stdout || null,
      },
      Errors: errors,
      Confidence: confidence,
    },
    { status: ok ? 200 : 500 },
  );
}
