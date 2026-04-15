import { spawnSync } from "node:child_process";
import { healingRunnerService } from "@/lib/healing/agent-runner";

export function checkKubectlAccess() {
  const check = spawnSync("kubectl", ["version", "--client"], { encoding: "utf-8" });
  return {
    ok: check.status === 0,
    status: check.status,
    stdout: check.stdout || "",
    stderr: check.stderr || "",
  };
}

export function startAgentRun(options) {
  return healingRunnerService.startHealing(options);
}

export function pushRunnerLog(input) {
  healingRunnerService.appendExternalLog(input);
}

export function getRunnerSnapshot() {
  return {
    status: healingRunnerService.getAgentStatus(),
    lifecycle: healingRunnerService.getIssueLifecycle(),
    logs: healingRunnerService.getExecutionLogs(),
  };
}
