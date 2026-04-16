import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";

const INFRA_ROOT = process.env.INFRA_ROOT || "./infra";

function walk(dir, visitor) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, visitor);
    } else {
      visitor(fullPath, entry.name);
    }
  }
}

const server = new Server(
  { name: "filesystem-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "find_service_config",
      description: "Finds Helm values, K8s manifests, or Terraform files for a service",
      inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] }
    },
    {
      name: "read_config_file",
      description: "Reads a specific config file by path",
      inputSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] }
    },
    {
      name: "find_shared_dependencies",
      description: "Finds which services share a dependency (e.g. all services using the same postgres instance)",
      inputSchema: { type: "object", properties: { dependency: { type: "string" } }, required: ["dependency"] }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "find_service_config") {
    const found = [];
    walk(INFRA_ROOT, (fullPath, fileName) => {
      const isConfigFile = /\.(ya?ml|tf)$/i.test(fileName);
      if (isConfigFile && fileName.includes(args.service)) {
        found.push(fullPath);
      }
    });
    return { content: [{ type: "text", text: JSON.stringify({ service: args.service, configs: found }, null, 2) }] };
  }

  if (name === "read_config_file") {
    try {
      const content = fs.readFileSync(args.file_path, "utf8");
      return { content: [{ type: "text", text: content }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error reading file: ${error.message}` }] };
    }
  }

  if (name === "find_shared_dependencies") {
    const results = {};
    walk(INFRA_ROOT, (fullPath) => {
      try {
        const content = fs.readFileSync(fullPath, "utf8");
        if (content.includes(args.dependency)) {
          results[fullPath] = true;
        }
      } catch {
        // Ignore binary/unreadable files.
      }
    });
    return { content: [{ type: "text", text: JSON.stringify({ dependency: args.dependency, found_in: Object.keys(results) }, null, 2) }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);