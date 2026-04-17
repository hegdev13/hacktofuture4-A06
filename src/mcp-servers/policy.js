import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Structured policy: each rule has conditions and a blocker reason
const POLICIES = {
  latency_spike: {
    actions: [
      {
        action: "scale_replicas",
        allowed: true,
        conditions: ["no_recent_deploy OR recent_deploy_unrelated"],
        requires_approval: false,
        max_scale_factor: 3
      },
      {
        action: "rollback",
        allowed: true,
        conditions: ["recent_deploy_within_30m"],
        requires_approval: false
      },
      {
        action: "shift_traffic",
        allowed: true,
        conditions: ["healthy_canary_exists"],
        requires_approval: true
      },
      {
        action: "restart_pod",
        allowed: true,
        conditions: ["always"],
        requires_approval: false
      }
    ]
  },
  high_error_rate: {
    actions: [
      { action: "rollback", allowed: true, conditions: ["recent_deploy_within_30m"], requires_approval: false },
      { action: "circuit_break", allowed: true, conditions: ["dependency_degraded"], requires_approval: false },
      { action: "scale_replicas", allowed: false, blocked_reason: "Scaling does not fix error rate — investigate root cause first", requires_approval: false },
    ]
  },
  pod_crash_loop: {
    actions: [
      { action: "restart_pod", allowed: true, conditions: ["always"], requires_approval: false },
      { action: "rollback", allowed: true, conditions: ["recent_deploy_within_30m"], requires_approval: false },
      { action: "scale_replicas", allowed: false, blocked_reason: "Scaling a crashing pod creates more crashing pods", requires_approval: false }
    ]
  },
  queue_backlog: {
    actions: [
      { action: "scale_consumers", allowed: true, conditions: ["always"], requires_approval: false },
      { action: "pause_producers", allowed: true, conditions: ["backlog_above_1000"], requires_approval: true },
      { action: "rollback", allowed: false, blocked_reason: "Queue backlog is not a deploy regression pattern", requires_approval: false }
    ]
  },
  db_connection_exhaustion: {
    actions: [
      { action: "restart_connection_pool", allowed: true, conditions: ["always"], requires_approval: false },
      { action: "scale_replicas", allowed: false, blocked_reason: "More replicas = more connections. Will worsen the incident.", requires_approval: false },
      { action: "rollback", allowed: true, conditions: ["recent_deploy_within_30m"], requires_approval: false }
    ]
  }
};

// Global guardrails that override all policies
const GUARDRAILS = [
  { rule: "never_rollback_database", description: "Never rollback a database service automatically. Require human approval." },
  { rule: "never_delete_persistent_volumes", description: "No action may delete PVCs or PVs." },
  { rule: "max_one_action_per_service_per_5min", description: "Prevent action storms — only one automated action per service per 5-minute window." },
  { rule: "production_hours_approval", description: "Actions affecting payment or auth services during 09:00-22:00 UTC require approval." }
];

const DB_SERVICES = new Set(["postgres", "mysql", "mongodb", "redis"]);

const server = new Server(
  { name: "policy-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_allowed_actions",
      description: "Returns which actions are permitted for an incident type, with constraints and block reasons",
      inputSchema: {
        type: "object",
        properties: {
          incident_type: { type: "string" },
          context: {
            type: "object",
            properties: {
              recent_deploy: { type: "boolean" },
              deploy_age_minutes: { type: "number" },
              service: { type: "string" },
              is_database: { type: "boolean" }
            }
          }
        },
        required: ["incident_type"]
      }
    },
    {
      name: "check_action",
      description: "Checks if a specific action is allowed. Returns allowed/blocked with a reason.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string" },
          incident_type: { type: "string" },
          service: { type: "string" }
        },
        required: ["action", "incident_type", "service"]
      }
    },
    {
      name: "get_guardrails",
      description: "Returns global guardrails that apply regardless of incident type",
      inputSchema: { type: "object", properties: {} }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "get_allowed_actions") {
    const policy = POLICIES[args.incident_type];
    if (!policy) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `No policy for incident type: ${args.incident_type}. Human review required.` }) }] };
    }

    const ctx = args.context ?? {};
    const evaluated = policy.actions.map((action) => {
      if (action.action === "rollback" && ctx.recent_deploy === false) {
        return { ...action, allowed: false, blocked_reason: "No recent deployment found — rollback has no target" };
      }

      if (ctx.is_database && action.action !== "restart_connection_pool") {
        return { ...action, requires_approval: true, approval_reason: "Database services require human approval" };
      }

      return action;
    });

    return { content: [{ type: "text", text: JSON.stringify({ incident_type: args.incident_type, actions: evaluated, guardrails: GUARDRAILS }, null, 2) }] };
  }

  if (name === "check_action") {
    const policy = POLICIES[args.incident_type];
    if (!policy) {
      return { content: [{ type: "text", text: JSON.stringify({ allowed: false, reason: "Unknown incident type — default deny" }) }] };
    }

    const rule = policy.actions.find((action) => action.action === args.action);
    if (!rule) {
      return { content: [{ type: "text", text: JSON.stringify({ allowed: false, reason: `Action ${args.action} not defined in policy for ${args.incident_type}` }) }] };
    }

    if (DB_SERVICES.has(args.service) && args.action === "rollback") {
      return { content: [{ type: "text", text: JSON.stringify({ allowed: false, reason: "Guardrail: never auto-rollback database services" }) }] };
    }

    return { content: [{ type: "text", text: JSON.stringify(rule, null, 2) }] };
  }

  if (name === "get_guardrails") {
    return { content: [{ type: "text", text: JSON.stringify(GUARDRAILS, null, 2) }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);