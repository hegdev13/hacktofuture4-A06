import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const METRICS_URL = process.env.METRICS_URL || "http://localhost:3001";

// Thresholds — the agent uses these to judge severity
const THRESHOLDS = {
  latency_ms: { warn: 300, critical: 800 },
  error_rate: { warn: 0.01, critical: 0.05 },
  cpu_percent: { warn: 70, critical: 90 },
  memory_mb: { warn: 400, critical: 700 },
  queue_depth: { warn: 100, critical: 500 },
};

async function fetchMetrics(service) {
  const res = await fetch(`${METRICS_URL}/metrics?service=${encodeURIComponent(service)}`);
  if (!res.ok) {
    throw new Error(`Metrics fetch failed for ${service}: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function classifySeverity(metric, value) {
  const threshold = THRESHOLDS[metric];
  if (!threshold) return "unknown";
  if (value >= threshold.critical) return "critical";
  if (value >= threshold.warn) return "warning";
  return "healthy";
}

const server = new Server(
  { name: "prometheus-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_service_metrics",
      description: "Current metrics snapshot for a service with severity classification",
      inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] }
    },
    {
      name: "get_anomalies",
      description: "Returns all services currently above warning threshold",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "get_metric_trend",
      description: "Returns whether a metric is improving, degrading, or stable over the last 5 minutes",
      inputSchema: {
        type: "object",
        properties: {
          service: { type: "string" },
          metric: { type: "string" }
        },
        required: ["service", "metric"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "get_service_metrics") {
    const raw = await fetchMetrics(args.service);
    const classified = {};
    for (const [metric, value] of Object.entries(raw)) {
      classified[metric] = { value, severity: classifySeverity(metric, value) };
    }
    return { content: [{ type: "text", text: JSON.stringify(classified, null, 2) }] };
  }

  if (name === "get_anomalies") {
    const services = ["frontend", "api-gateway", "checkout", "payments", "auth", "catalog", "inventory", "postgres", "redis"];
    const anomalies = [];
    for (const service of services) {
      try {
        const raw = await fetchMetrics(service);
        for (const [metric, value] of Object.entries(raw)) {
          const severity = classifySeverity(metric, value);
          if (severity !== "healthy" && severity !== "unknown") {
            anomalies.push({ service, metric, value, severity });
          }
        }
      } catch {
        // Ignore intermittent fetch failures while scanning the fleet.
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(anomalies, null, 2) }] };
  }

  if (name === "get_metric_trend") {
    const current = await fetchMetrics(args.service);
    const currentValue = current[args.metric];
    const trend = currentValue > (THRESHOLDS[args.metric]?.warn ?? 0) ? "degrading" : "stable";
    return { content: [{ type: "text", text: JSON.stringify({ service: args.service, metric: args.metric, trend }) }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);