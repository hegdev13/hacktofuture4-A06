import type { ClusterSnapshot } from "@/lib/kube/types";

export type DependencyNode = {
  id: string;
  name: string;
  status: "running" | "failed" | "pending";
  dependsOn: string[];
  healthScore: number;
};

export type DependencyTarget = {
  node: string;
  confidence: number;
};

export type DependencyGraph = Record<string, string[]>;
export type DependencyGraphWithConfidence = Record<string, DependencyTarget[]>;

type PodLike = {
  pod_name?: string;
  name?: string;
  namespace?: string;
  status?: string;
  cpu_usage?: number | null;
  memory_usage?: number | null;
  restart_count?: number | null;
  labels?: unknown;
  spec?: {
    serviceName?: string;
    containers?: Array<{ env?: Array<{ name?: string; value?: string }> }>;
    initContainers?: Array<{ env?: Array<{ name?: string; value?: string }> }>;
  };
  env?: Array<{ name?: string; value?: string }>;
  envVars?: Record<string, string>;
};

type ConfigLike = Record<string, unknown> | string;

type LogInput =
  | Record<string, string | string[]>
  | Array<{ service?: string; pod_name?: string; logs?: string | string[] }>;

const SERVICE_TOKEN_REGEX = /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]+)*(?:\.svc\.cluster\.local)?)\b/gi;
const URL_HOST_REGEX = /(?:https?:\/\/)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]+)*(?:\.svc\.cluster\.local)?)(?::\d+)?(?:\/[^\s]*)?/gi;

const LOG_HINT_REGEX = [
  /connecting\s+to\s+([a-z0-9.-]+)/gi,
  /error\s+calling\s+([a-z0-9.-]+)/gi,
  /failed\s+to\s+connect\s+to\s+([a-z0-9.-]+)/gi,
  /dial\s+tcp\s+([a-z0-9.-]+)/gi,
  /call(?:ing)?\s+([a-z0-9.-]+(?:-service)?)/gi,
];

function serviceNameFromPodName(podName: string): string {
  const normalized = podName.toLowerCase();
  // Typical pod naming: service-6b7f8d4c9f-x2abc
  const withoutReplicaSet = normalized.replace(/-[a-f0-9]{8,10}-[a-z0-9]{5}$/i, "");
  const withoutOrdinal = withoutReplicaSet.replace(/-\d+$/, "");
  return withoutOrdinal;
}

function guessServiceNameFromPod(pod: PodLike): string {
  const labels = parseJsonObject(pod.labels);
  const labelService =
    asNonEmptyString(labels["app.kubernetes.io/name"]) ||
    asNonEmptyString(labels.app) ||
    asNonEmptyString(pod.spec?.serviceName);

  if (labelService) {
    return normalizeServiceName(labelService) || labelService.toLowerCase();
  }

  const podName = pod.pod_name || pod.name || "unknown";
  return serviceNameFromPodName(podName);
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function extractCandidatesFromText(text: string): string[] {
  const candidates = new Set<string>();

  for (const match of text.matchAll(URL_HOST_REGEX)) {
    if (match[1]) candidates.add(match[1]);
  }

  for (const match of text.matchAll(SERVICE_TOKEN_REGEX)) {
    if (match[1]) candidates.add(match[1]);
  }

  return Array.from(candidates)
    .map((c) => normalizeServiceName(c))
    .filter((c): c is string => Boolean(c));
}

function extractFromDependencyLabels(labels: Record<string, unknown>): DependencyTarget[] {
  const keys = [
    "app.kubernetes.io/depends-on",
    "dependencies",
    "requires",
  ];

  const targets: DependencyTarget[] = [];
  for (const key of keys) {
    const raw = labels[key];
    if (typeof raw !== "string") continue;
    for (const token of raw.split(/[\s,;]+/)) {
      const normalized = normalizeServiceName(token);
      if (normalized) {
        targets.push({ node: normalized, confidence: 0.95 });
      }
    }
  }

  return dedupeTargets(targets);
}

/**
 * Normalize service references across env/config/log sources.
 * - removes protocol
 * - removes path/query/fragment
 * - removes port
 * - strips DNS suffixes like .svc.cluster.local
 */
export function normalizeServiceName(name: string): string {
  let s = (name || "").trim().toLowerCase();
  if (!s) return "";

  // Drop UI/debug suffixes like "frontend (deprecated)" or bracketed tags.
  s = s.replace(/\s*\(.*$/, "");
  s = s.replace(/\s*\[.*$/, "");
  s = s.replace(/\s+.*/, "");

  s = s.replace(/^['"]|['"]$/g, "");
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0] || "";
  s = s.replace(/:\d+$/, "");

  // service.namespace.svc.cluster.local -> service
  if (s.endsWith(".svc.cluster.local")) {
    s = s.slice(0, -".svc.cluster.local".length);
  }
  const dnsParts = s.split(".").filter(Boolean);
  if (dnsParts.length >= 2) {
    s = dnsParts[0];
  }

  s = s.replace(/[^a-z0-9-]/g, "");
  s = s.replace(/-[a-f0-9]{8,10}-[a-z0-9]{5}$/i, "");
  s = s.replace(/-\d+$/, "");
  if (!s || s.length < 2) return "";

  const banned = new Set([
    "http",
    "https",
    "localhost",
    "cluster",
    "local",
    "svc",
    "com",
    "org",
    "net",
    "url",
    "port",
    "true",
    "false",
  ]);
  if (banned.has(s)) return "";
  return s;
}

function dedupeTargets(targets: DependencyTarget[]): DependencyTarget[] {
  const byNode = new Map<string, number>();
  for (const t of targets) {
    if (!t.node) continue;
    const prev = byNode.get(t.node) ?? 0;
    byNode.set(t.node, Math.max(prev, t.confidence));
  }

  return Array.from(byNode.entries())
    .map(([node, confidence]) => ({ node, confidence }))
    .sort((a, b) => a.node.localeCompare(b.node));
}

/**
 * Extract dependencies from pod environment variables.
 */
export function extractFromEnv(podSpec: PodLike): DependencyTarget[] {
  const targets: DependencyTarget[] = [];
  const containers = [
    ...(podSpec.spec?.containers || []),
    ...(podSpec.spec?.initContainers || []),
  ];

  for (const container of containers) {
    for (const env of container.env || []) {
      if (!env?.value) continue;
      for (const candidate of extractCandidatesFromText(env.value)) {
        targets.push({ node: candidate, confidence: 0.95 });
      }
    }
  }

  // Alternate shape support: flat env array and key-value envVars.
  for (const env of podSpec.env || []) {
    if (!env?.value) continue;
    for (const candidate of extractCandidatesFromText(env.value)) {
      targets.push({ node: candidate, confidence: 0.95 });
    }
  }
  for (const value of Object.values(podSpec.envVars || {})) {
    for (const candidate of extractCandidatesFromText(String(value))) {
      targets.push({ node: candidate, confidence: 0.95 });
    }
  }

  return dedupeTargets(targets);
}

function collectStringsDeep(input: unknown, out: string[]) {
  if (typeof input === "string") {
    out.push(input);
    return;
  }
  if (Array.isArray(input)) {
    for (const v of input) collectStringsDeep(v, out);
    return;
  }
  if (input && typeof input === "object") {
    for (const v of Object.values(input as Record<string, unknown>)) {
      collectStringsDeep(v, out);
    }
  }
}

/**
 * Extract dependencies from ConfigMaps/Secrets-like config payloads.
 */
export function extractFromConfig(configData: ConfigLike): DependencyTarget[] {
  const strings: string[] = [];
  collectStringsDeep(configData, strings);

  const targets: DependencyTarget[] = [];
  for (const text of strings) {
    for (const candidate of extractCandidatesFromText(text)) {
      targets.push({ node: candidate, confidence: 0.9 });
    }
  }
  return dedupeTargets(targets);
}

function extractLogLines(logs: string | string[]): string[] {
  if (Array.isArray(logs)) return logs.flatMap((l) => String(l).split(/\r?\n/));
  return String(logs || "").split(/\r?\n/);
}

/**
 * Extract dependencies from logs using basic connection/call heuristics.
 */
export function extractFromLogs(logs: string | string[]): DependencyTarget[] {
  const targets: DependencyTarget[] = [];
  const lines = extractLogLines(logs);

  for (const line of lines) {
    for (const rx of LOG_HINT_REGEX) {
      for (const match of line.matchAll(rx)) {
        if (!match[1]) continue;
        const normalized = normalizeServiceName(match[1]);
        if (normalized) {
          targets.push({ node: normalized, confidence: 0.7 });
        }
      }
    }

    // DNS/URL fallback in logs.
    for (const candidate of extractCandidatesFromText(line)) {
      targets.push({ node: candidate, confidence: 0.6 });
    }
  }

  return dedupeTargets(targets);
}

type BuildGraphResult = {
  adjacency: DependencyGraph;
  withConfidence: DependencyGraphWithConfidence;
};

/**
 * Build directed graph A -> B where A depends on B.
 * Merges env, config, DNS-pattern discovery, and logs without duplicate edges.
 */
export function buildGraph(
  pods: PodLike[],
  configs: Record<string, ConfigLike> = {},
  logs: LogInput = {}
): BuildGraphResult {
  const confidenceMap = new Map<string, Map<string, number>>();
  const knownServices = pods.map((p) => guessServiceNameFromPod(p));
  const aliasToService = new Map<string, string>();

  const addAlias = (alias: string, service: string) => {
    if (!alias) return;
    aliasToService.set(alias, service);
  };

  for (const service of knownServices) {
    const normalized = normalizeServiceName(service) || service.toLowerCase();
    const compact = normalized.replace(/-/g, "");
    addAlias(normalized, service);
    addAlias(compact, service);
    if (normalized.endsWith("-service")) {
      addAlias(normalized.replace(/-service$/, "service"), service);
    }
    if (normalized.endsWith("service")) {
      addAlias(normalized.replace(/service$/, "-service"), service);
    }
  }

  const resolveServiceName = (raw: string): string => {
    const normalized = normalizeServiceName(raw);
    if (!normalized) return "";
    const compact = normalized.replace(/-/g, "");
    return aliasToService.get(normalized) || aliasToService.get(compact) || normalized;
  };

  const ensureNode = (service: string) => {
    if (!confidenceMap.has(service)) confidenceMap.set(service, new Map());
  };

  const addEdge = (from: string, to: string, confidence: number) => {
    const source = resolveServiceName(from) || (normalizeServiceName(from) || from.toLowerCase());
    const target = resolveServiceName(to);
    if (!source || !target || source === target) return;

    ensureNode(source);
    const targetMap = confidenceMap.get(source)!;
    const prev = targetMap.get(target) ?? 0;
    if (confidence > prev) targetMap.set(target, confidence);
  };

  for (const pod of pods) {
    const service = guessServiceNameFromPod(pod);
    ensureNode(service);

    for (const dep of extractFromEnv(pod)) {
      addEdge(service, dep.node, dep.confidence);
    }

    const cfg =
      configs[service] ??
      configs[pod.pod_name || ""] ??
      configs[pod.name || ""];
    if (cfg !== undefined) {
      for (const dep of extractFromConfig(cfg)) {
        addEdge(service, dep.node, dep.confidence);
      }
    }

    // Optional label-based config hints for compatibility.
    const labels = parseJsonObject(pod.labels);
    for (const dep of extractFromDependencyLabels(labels)) {
      addEdge(service, dep.node, dep.confidence);
    }

    for (const labelValue of Object.values(labels)) {
      if (typeof labelValue !== "string") continue;
      for (const dep of extractFromConfig(labelValue)) {
        addEdge(service, dep.node, dep.confidence);
      }
    }
  }

  if (Array.isArray(logs)) {
    for (const entry of logs) {
      const service = resolveServiceName(entry.service || "") || serviceNameFromPodName(entry.pod_name || "");
      ensureNode(service);
      for (const dep of extractFromLogs(entry.logs || "")) {
        addEdge(service, dep.node, dep.confidence);
      }
    }
  } else {
    for (const [serviceOrPod, content] of Object.entries(logs || {})) {
      const service = resolveServiceName(serviceOrPod) || serviceNameFromPodName(serviceOrPod);
      ensureNode(service);
      for (const dep of extractFromLogs(content)) {
        addEdge(service, dep.node, dep.confidence);
      }
    }
  }

  const adjacency: DependencyGraph = {};
  const withConfidence: DependencyGraphWithConfidence = {};

  for (const [source, targets] of confidenceMap.entries()) {
    const sortedTargets = Array.from(targets.entries())
      .map(([node, confidence]) => ({ node, confidence }))
      .sort((a, b) => a.node.localeCompare(b.node));

    adjacency[source] = sortedTargets.map((t) => t.node);
    withConfidence[source] = sortedTargets;
  }

  return { adjacency, withConfidence };
}

function normalizeStatus(status: string): "running" | "failed" | "pending" {
  const s = status.toLowerCase();
  if (
    s.includes("running") ||
    s.includes("healthy") ||
    s.includes("ready") ||
    s.includes("succeeded") ||
    s === "ok"
  ) {
    return "running";
  }
  if (s.includes("pending") || s.includes("init")) return "pending";
  return "failed";
}

function average(values: number[]) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function calculateHealth(cpu: number, memory: number, restarts: number, failureRatio: number) {
  const cpuPenalty = Math.min(45, Math.max(0, cpu) * 40);
  const memoryPenalty = Math.min(25, Math.max(0, memory) / 1024 / 1024 / 512 * 25);
  const restartPenalty = Math.min(15, restarts * 3);
  const failurePenalty = Math.min(40, failureRatio * 40);
  const score = 100 - cpuPenalty - memoryPenalty - restartPenalty - failurePenalty;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function buildDependencyImpact(snapshot: ClusterSnapshot): {
  graphPods: DependencyNode[];
  status: "healthy" | "degraded" | "critical";
  healthPercent: number;
  summary: string;
} {
  // Group pods by service
  const servicePods = new Map<string, typeof snapshot.pods>();
  const podRepresentations: PodLike[] = [];

  for (const pod of snapshot.pods as Array<Record<string, unknown>>) {
    const typedPod = pod as PodLike;
    const service = guessServiceNameFromPod(typedPod);
    const group = servicePods.get(service) ?? [];
    group.push(pod as (typeof snapshot.pods)[number]);
    servicePods.set(service, group);

    podRepresentations.push(typedPod);
  }

  // Calculate health for each service
  const serviceHealth = new Map<string, { health: number; status: "running" | "failed" | "pending" }>();
  for (const [service, pods] of servicePods.entries()) {
    const cpu = average(pods.map((p) => (typeof p.cpu_usage === "number" ? p.cpu_usage : 0)));
    const memory = average(pods.map((p) => (typeof p.memory_usage === "number" ? p.memory_usage : 0)));
    const restarts = average(pods.map((p) => p.restart_count ?? 0));
    const failed = pods.filter((p) => normalizeStatus(p.status) === "failed").length;
    const pending = pods.filter((p) => normalizeStatus(p.status) === "pending").length;
    const failureRatio = pods.length ? failed / pods.length : 0;

    const health = calculateHealth(cpu, memory, restarts, failureRatio);
    // Status precedence follows pod reality, not inferred health thresholds.
    const status: "running" | "failed" | "pending" =
      failed > 0 ? "failed" : pending > 0 ? "pending" : "running";

    serviceHealth.set(service, { health, status });
  }

  // Build dependency map dynamically from env/config/log sources.
  const enriched = snapshot as ClusterSnapshot & {
    configs?: Record<string, ConfigLike>;
    logs?: LogInput;
  };
  const graph = buildGraph(podRepresentations, enriched.configs || {}, enriched.logs || {});

  // Build graph nodes with statuses
  const graphPods: DependencyNode[] = [];
  for (const [service, health] of serviceHealth.entries()) {
    graphPods.push({
      id: service,
      name: service,
      status: health.status,
      dependsOn: graph.adjacency[service] ?? [],
      healthScore: health.health,
    });
  }

  // Calculate overall cluster health
  const clusterHealth = serviceHealth.size > 0
    ? Math.round(
        Array.from(serviceHealth.values())
          .reduce((sum, h) => sum + h.health, 0) / serviceHealth.size
      )
    : 100;

  const status: "healthy" | "degraded" | "critical" =
    clusterHealth >= 80 ? "healthy" : clusterHealth >= 50 ? "degraded" : "critical";

  const failedCount = graphPods.filter(p => p.status === "failed").length;
  const summary = failedCount > 0
    ? `${failedCount} service(s) in failed state. Cluster health: ${clusterHealth}%`
    : `All services healthy. Cluster health: ${clusterHealth}%`;

  return {
    graphPods,
    status,
    healthPercent: clusterHealth,
    summary,
  };
}
