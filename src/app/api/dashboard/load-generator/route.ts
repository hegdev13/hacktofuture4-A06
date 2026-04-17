import { spawnSync } from "node:child_process";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const BodySchema = z.object({
  users: z.coerce.number().int().min(0).max(500).default(40),
  namespace: z.string().min(1).default("loadgenerator"),
  deployment: z.string().min(1).default("loadgenerator"),
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

function fail(message: string, status = 500) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return fail("invalid_request", 400);
  }

  const { users, namespace, deployment } = parsed.data;

  const exists = runKubectl(["get", "deployment", deployment, "-n", namespace, "-o", "name"]);
  if (!exists.ok) {
    return fail(exists.stderr || `Deployment ${namespace}/${deployment} not found`, 404);
  }

  const setEnv = runKubectl([
    "set",
    "env",
    `deployment/${deployment}`,
    "-n",
    namespace,
    `USERS=${String(users)}`,
  ]);

  if (!setEnv.ok) {
    return fail(setEnv.stderr || `Failed to update USERS for ${namespace}/${deployment}`);
  }

  const restart = runKubectl(["rollout", "restart", `deployment/${deployment}`, "-n", namespace]);
  if (!restart.ok) {
    return fail(restart.stderr || `Failed to restart ${namespace}/${deployment}`);
  }

  const rollout = runKubectl(["rollout", "status", `deployment/${deployment}`, "-n", namespace, "--timeout=60s"]);

  return NextResponse.json({
    ok: rollout.ok,
    namespace,
    deployment,
    users,
    message: rollout.ok
      ? `Load generator set to USERS=${users} and restarted successfully.`
      : `Load generator restarted with USERS=${users}, but rollout check timed out.`,
    details: rollout.ok ? rollout.stdout : rollout.stderr,
  });
}
