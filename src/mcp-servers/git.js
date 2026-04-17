import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";

const REPO_PATH = process.env.REPO_PATH || process.cwd();

function git(cmd) {
  return execSync(`git -C ${JSON.stringify(REPO_PATH)} ${cmd}`, { encoding: "utf8" }).trim();
}

function parseDeployTags() {
  // Convention: tag deploys as deploy/<service>/<timestamp>
  try {
    const tags = git("tag -l 'deploy/*' --sort=-creatordate").split("\n").filter(Boolean);
    return tags.map((tag) => {
      const [, service, timestamp] = tag.split("/");
      return { tag, service, timestamp: new Date(timestamp), sha: git(`rev-list -n 1 ${tag}`) };
    });
  } catch {
    return [];
  }
}

const server = new Server(
  { name: "git-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_recent_deployments",
      description: "Returns deployments in the last N minutes across all services",
      inputSchema: {
        type: "object",
        properties: { window_minutes: { type: "number", default: 60 } }
      }
    },
    {
      name: "get_deployment_diff",
      description: "Returns the changed files and summary for a specific deploy tag",
      inputSchema: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] }
    },
    {
      name: "correlate_deploy_to_incident",
      description: "Checks if any deployment happened within the correlation window before an incident timestamp",
      inputSchema: {
        type: "object",
        properties: {
          incident_time: { type: "string", description: "ISO8601 timestamp" },
          correlation_window_minutes: { type: "number", default: 30 }
        },
        required: ["incident_time"]
      }
    },
    {
      name: "get_rollback_target",
      description: "Returns the previous stable deploy SHA for a service",
      inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "get_recent_deployments") {
    const windowMs = (args.window_minutes ?? 60) * 60 * 1000;
    const cutoff = new Date(Date.now() - windowMs);
    const deploys = parseDeployTags().filter((deploy) => deploy.timestamp > cutoff);
    return { content: [{ type: "text", text: JSON.stringify(deploys, null, 2) }] };
  }

  if (name === "get_deployment_diff") {
    try {
      const stat = git(`diff ${args.tag}^..${args.tag} --stat`);
      const files = git(`diff ${args.tag}^..${args.tag} --name-only`).split("\n").filter(Boolean);
      return { content: [{ type: "text", text: JSON.stringify({ tag: args.tag, changed_files: files, stat }) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }

  if (name === "correlate_deploy_to_incident") {
    const incidentTime = new Date(args.incident_time);
    const windowMs = (args.correlation_window_minutes ?? 30) * 60 * 1000;
    const cutoff = new Date(incidentTime.getTime() - windowMs);
    const candidates = parseDeployTags().filter((deploy) => deploy.timestamp >= cutoff && deploy.timestamp <= incidentTime);
    const correlated = candidates.length > 0;
    return { content: [{ type: "text", text: JSON.stringify({ correlated, candidates, verdict: correlated ? "LIKELY_REGRESSION" : "NO_RECENT_DEPLOY" }) }] };
  }

  if (name === "get_rollback_target") {
    const deploys = parseDeployTags().filter((deploy) => deploy.service === args.service);
    if (deploys.length < 2) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "No previous deploy found" }) }] };
    }

    const [current, previous] = deploys;
    return { content: [{ type: "text", text: JSON.stringify({ current: current.sha, rollback_to: previous.sha, tag: previous.tag }) }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);