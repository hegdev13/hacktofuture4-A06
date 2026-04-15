const path = require("path");

function fail(message) {
  process.stderr.write(String(message));
  process.exit(1);
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

      const result = agent.analyzeMetrics({ pods });
      const dependencyMap = agent.POD_DEPENDENCIES || {};

      process.stdout.write(JSON.stringify({ result, dependencyMap }));
    } catch (err) {
      fail(err && err.message ? err.message : String(err));
    }
  });
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
