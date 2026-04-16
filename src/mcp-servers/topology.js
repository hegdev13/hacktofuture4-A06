import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Your real service graph — replace with dynamic K8s discovery later
const SERVICE_GRAPH = {
  frontend: { upstream: [], downstream: ["api-gateway"] },
  "api-gateway": { upstream: ["frontend"], downstream: ["auth", "checkout", "catalog"] },
  checkout: { upstream: ["api-gateway"], downstream: ["payments", "inventory"] },
  payments: { upstream: ["checkout"], downstream: ["postgres", "stripe-proxy"] },
  auth: { upstream: ["api-gateway"], downstream: ["postgres", "redis"] },
  catalog: { upstream: ["api-gateway"], downstream: ["postgres", "redis"] },
  inventory: { upstream: ["checkout"], downstream: ["postgres"] },
  postgres: { upstream: ["payments", "auth", "catalog", "inventory"], downstream: [] },
  redis: { upstream: ["auth", "catalog"], downstream: [] },
  "stripe-proxy": { upstream: ["payments"], downstream: [] },
};

function getBlastRadius(serviceName) {
  const visited = new Set();
  const tiers = [];
  let current = [serviceName];

  while (current.length > 0) {
    tiers.push([...current]);
    const next = [];
    for (const svc of current) {
      for (const up of SERVICE_GRAPH[svc]?.upstream ?? []) {
        if (!visited.has(up)) {
          visited.add(up);
          next.push(up);
        }
      }
    }
    current = next;
  }

  return tiers;
}

const server = new Server(
  { name: "topology-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_dependencies",
      description: "Returns upstream and downstream services for a given service",
      inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] }
    },
    {
      name: "get_blast_radius",
      description: "Returns blast radius tiers. Tier 0 is the degraded service, tier 1 direct callers, tier 2 transitive callers.",
      inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] }
    },
    {
      name: "get_critical_path",
      description: "Returns whether a service is on the critical user-facing path",
      inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "get_dependencies") {
    const svc = SERVICE_GRAPH[args.service];
    if (!svc) {
      return { content: [{ type: "text", text: `Unknown service: ${args.service}` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(svc, null, 2) }] };
  }

  if (name === "get_blast_radius") {
    const tiers = getBlastRadius(args.service);
    const result = tiers.map((tier, i) => ({
      tier: i,
      label: i === 0 ? "degraded" : i === 1 ? "direct callers" : "transitive callers",
      services: tier
    }));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "get_critical_path") {
    const criticalServices = ["frontend", "api-gateway", "checkout", "payments", "auth"];
    const isCritical = criticalServices.includes(args.service);
    return { content: [{ type: "text", text: JSON.stringify({ service: args.service, critical: isCritical }) }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);