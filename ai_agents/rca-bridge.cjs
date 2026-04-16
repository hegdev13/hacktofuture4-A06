const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

function fail(message) {
  process.stderr.write(String(message));
  process.exit(1);
}

function runLightgbmRca(pods, dependencyMap) {
  const scriptPath = path.join(process.cwd(), "ai_agents", "lightgbm_rca.py");
  if (!fs.existsSync(scriptPath)) return null;

  const modelDir = path.join(process.cwd(), "ai_agents", "models");
  const modelPath = path.join(modelDir, "lightgbm_rca_model.txt");
  const metaPath = path.join(modelDir, "lightgbm_rca_meta.json");
  if (!fs.existsSync(modelPath) || !fs.existsSync(metaPath)) return null;

  const payload = JSON.stringify({
    pods,
    dependency_map: dependencyMap || {},
  });

  const candidates = [process.env.PYTHON_BIN, "python3", "python"].filter(Boolean);
  let proc = null;
  for (const pyExec of candidates) {
    const cur = spawnSync(pyExec, [scriptPath, "--mode", "predict", "--model-dir", modelDir], {
      input: payload,
      encoding: "utf8",
      cwd: process.cwd(),
      timeout: 5000,
    });
    if (cur.status === 0) {
      proc = cur;
      break;
    }
  }

  if (!proc) {
    return null;
  }

  try {
    const parsed = JSON.parse(proc.stdout || "{}");
    if (!parsed || !Array.isArray(parsed.rootCauses)) return null;
    return parsed;
  } catch {
    return null;
  }
}

try {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });

  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(input || "{}");
      const pods = Array.isArray(payload.pods) ? payload.pods : [];

      const agentPath = path.join(process.cwd(), "ai_agents", "rca-agent.js");
      const agent = require(agentPath);

      if (typeof agent.analyzeMetrics !== "function") {
        fail("analyzeMetrics() not found in ai_agents/rca-agent.js");
      }

      const dependencyMap = agent.POD_DEPENDENCIES || {};
      const mlResult = runLightgbmRca(pods, dependencyMap);

      const result = mlResult || agent.analyzeMetrics({ pods });

      process.stdout.write(JSON.stringify({ result, dependencyMap }));
    } catch (err) {
      fail(err && err.message ? err.message : String(err));
    }
  });
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
