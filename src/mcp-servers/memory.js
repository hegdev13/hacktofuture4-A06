import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";

const MEMORY_PATH = process.env.MEMORY_PATH || "./incident_memory/history.json";

function loadMemory() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8"));
  } catch {
    return [];
  }
}

function saveMemory(records) {
  fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(records, null, 2));
}

// Token overlap similarity — no external deps needed
function tokenize(str) {
  return str.toLowerCase().split(/[\s_\-\.]+/).filter(Boolean);
}

function similarity(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  const intersection = [...ta].filter((token) => tb.has(token)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
}

function findSimilarIncidents(symptom, records, topK = 5, threshold = 0.3) {
  return records
    .map((record) => ({ ...record, score: similarity(symptom, record.symptom) }))
    .filter((record) => record.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// Rank remediations by success rate across similar incidents
function rankRemediations(similar) {
  const stats = {};
  for (const incident of similar) {
    if (!stats[incident.action]) {
      stats[incident.action] = { success: 0, failure: 0, total: 0 };
    }
    stats[incident.action].total++;
    stats[incident.action][incident.outcome === "success" ? "success" : "failure"]++;
  }

  return Object.entries(stats)
    .map(([action, counters]) => ({ action, success_rate: counters.success / counters.total, total_attempts: counters.total }))
    .sort((a, b) => b.success_rate - a.success_rate);
}

const server = new Server(
  { name: "memory-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "query_similar_incidents",
      description: "Finds past incidents similar to the current symptom and ranks which remediation worked best",
      inputSchema: { type: "object", properties: { symptom: { type: "string" } }, required: ["symptom"] }
    },
    {
      name: "record_outcome",
      description: "Records the result of a remediation attempt for future learning",
      inputSchema: {
        type: "object",
        properties: {
          symptom: { type: "string" },
          service: { type: "string" },
          action: { type: "string" },
          outcome: { type: "string", enum: ["success", "failure", "partial"] },
          notes: { type: "string" }
        },
        required: ["symptom", "service", "action", "outcome"]
      }
    },
    {
      name: "get_action_stats",
      description: "Returns success rate for a specific action type across all historical incidents",
      inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const records = loadMemory();

  if (name === "query_similar_incidents") {
    const similar = findSimilarIncidents(args.symptom, records);
    const ranked = rankRemediations(similar);
    return { content: [{ type: "text", text: JSON.stringify({ similar_incidents: similar, recommended_actions: ranked }, null, 2) }] };
  }

  if (name === "record_outcome") {
    const entry = { ...args, timestamp: new Date().toISOString(), id: Date.now().toString() };
    records.push(entry);
    saveMemory(records);
    return { content: [{ type: "text", text: JSON.stringify({ recorded: true, entry }) }] };
  }

  if (name === "get_action_stats") {
    const matching = records.filter((record) => record.action === args.action);
    const success = matching.filter((record) => record.outcome === "success").length;
    return { content: [{ type: "text", text: JSON.stringify({ action: args.action, total: matching.length, success_rate: matching.length > 0 ? success / matching.length : null }) }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);