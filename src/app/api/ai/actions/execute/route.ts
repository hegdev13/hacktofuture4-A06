import { NextResponse } from "next/server";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { publishObservabilityEvent } from "@/lib/observability/events";

const BodySchema = z.object({
  endpoint_id: z.string().uuid(),
  action: z.enum(["restart_pod", "scale_deployment", "rollback_deployment"]),
  namespace: z.string().min(1).default("default"),
  target: z.string().min(1),
  replicas: z.number().int().min(1).max(100).optional(),
  dryRun: z.boolean().optional(),
});

function buildCommand(input: z.infer<typeof BodySchema>) {
  if (input.action === "restart_pod") {
    return ["rollout", "restart", `deployment/${input.target}`, "-n", input.namespace];
  }
  if (input.action === "scale_deployment") {
    return ["scale", `deployment/${input.target}`, `--replicas=${input.replicas ?? 2}`, "-n", input.namespace];
  }
  return ["rollout", "undo", `deployment/${input.target}`, "-n", input.namespace];
}

export async function POST(request: Request) {
  const secret = request.headers.get("x-kubepulse-secret");
  if (!process.env.METRICS_POLL_SECRET || secret !== process.env.METRICS_POLL_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const args = buildCommand(parsed.data);
  const dryRun = parsed.data.dryRun ?? true;

  if (dryRun) {
    await publishObservabilityEvent({
      endpoint_id: parsed.data.endpoint_id,
      event_type: "ai_action",
      severity: "warning",
      title: `Dry-run: kubectl ${args.join(" ")}`,
      details: { action: parsed.data.action, target: parsed.data.target, namespace: parsed.data.namespace },
    });
    return NextResponse.json({ ok: true, dryRun: true, command: ["kubectl", ...args].join(" ") });
  }

  const run = spawnSync("kubectl", args, { encoding: "utf-8" });
  const ok = run.status === 0;

  await publishObservabilityEvent({
    endpoint_id: parsed.data.endpoint_id,
    event_type: "ai_action",
    severity: ok ? "info" : "critical",
    title: `${ok ? "Executed" : "Failed"}: kubectl ${args.join(" ")}`,
    details: {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      action: parsed.data.action,
    },
  });

  if (!ok) {
    return NextResponse.json({ ok: false, error: run.stderr || "kubectl failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, output: run.stdout });
}
