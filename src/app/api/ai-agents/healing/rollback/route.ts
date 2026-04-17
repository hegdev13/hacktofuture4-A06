import { spawnSync } from "node:child_process";
import { NextResponse } from "next/server";
import { healingRunnerService } from "@/lib/healing/agent-runner";
import type { HealingTargetKind } from "@/lib/healing/types";

export const runtime = "nodejs";

function deploymentNameFromTarget(name: string, kind: HealingTargetKind) {
  if (kind === "deployment") return name;

  const parts = name.split("-");
  if (parts.length >= 3) {
    return parts.slice(0, -2).join("-");
  }
  if (parts.length >= 2) {
    return parts.slice(0, -1).join("-");
  }
  return name;
}

type RollbackBody = {
  targetName?: string;
  targetNamespace?: string;
  targetKind?: HealingTargetKind;
  dryRun?: boolean;
};

type RollbackSnapshot = {
  capturedAt: string;
  issueId: string;
  targetName: string;
  targetNamespace: string;
  targetKind: "pod" | "deployment";
  deploymentName: string;
  deploymentManifest: {
    apiVersion: string;
    kind: string;
    metadata: {
      name: string;
      namespace: string;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    };
    spec: Record<string, unknown>;
  };
};

function rolloutStatus(deploymentName: string, namespace: string) {
  return spawnSync(
    "kubectl",
    ["rollout", "status", `deployment/${deploymentName}`, "-n", namespace, "--timeout=120s"],
    { encoding: "utf8", cwd: process.cwd() },
  );
}

function getCurrentDeploymentSpec(deploymentName: string, namespace: string): string | null {
  const dep = spawnSync("kubectl", ["get", "deployment", deploymentName, "-n", namespace, "-o", "json"], {
    encoding: "utf8",
    cwd: process.cwd(),
  });

  if (dep.status !== 0 || !dep.stdout) {
    return null;
  }

  try {
    const parsed = JSON.parse(dep.stdout) as { spec?: Record<string, unknown> };
    return parsed.spec ? JSON.stringify(parsed.spec) : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const sourceHeader = request.headers.get("x-healing-source");
  if (sourceHeader !== "dashboard-healing-page") {
    return NextResponse.json(
      {
        ok: false,
        error: "healing_rollback_restricted",
        details: "Rollback can only be triggered from the /dashboard/healing page.",
      },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as RollbackBody;
  const status = healingRunnerService.getAgentStatus();

  const targetName = (body.targetName || status.targetName || "").trim();
  const targetNamespace = (body.targetNamespace || status.targetNamespace || "default").trim() || "default";
  const targetKind = (body.targetKind || status.targetKind || "deployment") as HealingTargetKind;
  const dryRun = Boolean(body.dryRun);

  if (!targetName) {
    return NextResponse.json(
      {
        ok: false,
        error: "rollback_target_missing",
        details: "No rollback target found. Select a workload or run healing first.",
      },
      { status: 400 },
    );
  }

  const deploymentName = deploymentNameFromTarget(targetName, targetKind);
  const issueId = status.activeIssueId || `rollback-${new Date().toISOString()}`;
  const command = ["rollout", "undo", `deployment/${deploymentName}`, "-n", targetNamespace];
  const snapshot = healingRunnerService.getRollbackSnapshot() as RollbackSnapshot | null;
  const snapshotMatchesTarget = Boolean(
    snapshot &&
      snapshot.deploymentName === deploymentName &&
      snapshot.targetNamespace === targetNamespace,
  );

  healingRunnerService.appendExternalLog({
    issue_id: issueId,
    agent_name: "ExecutionerAgent",
    event_type: "FIXING",
    description: `Rollback requested for deployment ${targetNamespace}/${deploymentName}.`,
    action_taken: `Running kubectl ${command.join(" ")}`,
    status: "IN_PROGRESS",
  });

  if (dryRun) {
    const applyCmd =
      snapshotMatchesTarget && snapshot
        ? `kubectl apply -f <captured-manifest:${snapshot.targetNamespace}/${snapshot.deploymentName}>`
        : null;
    return NextResponse.json({
      ok: true,
      dryRun: true,
      command: `kubectl ${command.join(" ")}`,
      snapshotApplyCommand: applyCmd,
      target: {
        name: deploymentName,
        namespace: targetNamespace,
        kind: "deployment",
      },
    });
  }

  const beforeSpec = getCurrentDeploymentSpec(deploymentName, targetNamespace);
  const undo = spawnSync("kubectl", command, { encoding: "utf8", cwd: process.cwd() });
  const undoOutput = (undo.stdout || undo.stderr || "").trim();
  const undoFailed = undo.status !== 0;

  if (undoFailed && !snapshotMatchesTarget) {
    const details = undoOutput || "kubectl rollout undo failed";
    healingRunnerService.appendExternalLog({
      issue_id: issueId,
      agent_name: "ExecutionerAgent",
      event_type: "FAILED",
      description: `Rollback failed for ${targetNamespace}/${deploymentName}: ${details}`,
      action_taken: "Rollback command failed and no snapshot baseline matched target",
      status: "FAILED",
    });

    return NextResponse.json(
      {
        ok: false,
        error: "rollback_failed",
        details,
      },
      { status: 500 },
    );
  }

  let methodUsed: "rollout-undo" | "snapshot-restore" = "rollout-undo";

  if (undoFailed && snapshotMatchesTarget && snapshot) {
    const apply = spawnSync(
      "kubectl",
      ["apply", "-f", "-"],
      {
        encoding: "utf8",
        cwd: process.cwd(),
        input: JSON.stringify(snapshot.deploymentManifest),
      },
    );

    if (apply.status !== 0) {
      const details = (apply.stderr || apply.stdout || undoOutput || "snapshot restore failed").trim();
      healingRunnerService.appendExternalLog({
        issue_id: issueId,
        agent_name: "ExecutionerAgent",
        event_type: "FAILED",
        description: `Rollback failed for ${targetNamespace}/${deploymentName}: ${details}`,
        action_taken: "Snapshot restore after rollout undo failure also failed",
        status: "FAILED",
      });

      return NextResponse.json(
        {
          ok: false,
          error: "rollback_failed",
          details,
        },
        { status: 500 },
      );
    }

    methodUsed = "snapshot-restore";
  }

  const rollout = rolloutStatus(deploymentName, targetNamespace);

  const afterSpec = getCurrentDeploymentSpec(deploymentName, targetNamespace);
  const specChanged = Boolean(beforeSpec && afterSpec && beforeSpec !== afterSpec);

  const noChangeReason =
    !specChanged
      ? "Rollback completed but deployment spec is unchanged. If the self-heal was restart/delete only, Kubernetes rollback cannot recreate the prior runtime crash state."
      : undefined;

  const rolloutDetails = (rollout.stderr || rollout.stdout || "").trim();
  if (rollout.status !== 0) {
    const unhealthyMessage = `Rollback applied for ${targetNamespace}/${deploymentName}, but workload is currently unhealthy: ${rolloutDetails}`;
    healingRunnerService.appendExternalLog({
      issue_id: issueId,
      agent_name: "ExecutionerAgent",
      event_type: "RESOLVED",
      description: unhealthyMessage,
      action_taken: `Rollback method=${methodUsed}; restored previous state with unhealthy status`,
      status: "SUCCESS",
    });

    return NextResponse.json({
      ok: true,
      method: methodUsed,
      changed: specChanged,
      healthy: false,
      message: unhealthyMessage,
      target: {
        name: deploymentName,
        namespace: targetNamespace,
        kind: "deployment",
      },
      output: {
        undo: (undo.stdout || undo.stderr || "").trim(),
        verify: rolloutDetails,
      },
    });
  }

  healingRunnerService.appendExternalLog({
    issue_id: issueId,
    agent_name: "ExecutionerAgent",
    event_type: "RESOLVED",
    description: noChangeReason || `Rollback completed for deployment ${targetNamespace}/${deploymentName}.`,
    action_taken: `Rollback method=${methodUsed}; deployment verified healthy`,
    status: "SUCCESS",
  });

  return NextResponse.json({
    ok: true,
    method: methodUsed,
    changed: specChanged,
    message: noChangeReason,
    target: {
      name: deploymentName,
      namespace: targetNamespace,
      kind: "deployment",
    },
    output: {
      undo: (undo.stdout || undo.stderr || "").trim(),
      verify: rolloutDetails,
    },
  });
}
