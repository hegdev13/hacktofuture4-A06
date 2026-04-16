import { NextResponse } from 'next/server';

type RCAFailureType = 'CrashLoop' | 'Memory' | 'Latency' | 'DependencyFailure' | 'Unknown';
type RCASeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

type RCARootCause = {
  service: string;
  failureChain: string[];
  affectedNodes: string[];
  dependencyDepth: number;
  failureType: RCAFailureType;
  severity: RCASeverity;
  timestamp: string;
  confidence: number;
  reasoning: string;
};

type RCAOutput = {
  rootCauses: RCARootCause[];
};

type InputEntity = {
  name?: string;
  service?: string;
  pod?: string;
  selfIssue?: boolean;
  dependencyIssue?: boolean;
  status?: string;
  metrics?: {
    cpu?: number;
    memory?: number;
    latency?: number;
    restartCount?: number;
  };
  logs?: string[] | string;
  events?: string[] | string;
  timestamp?: string;
};

type RCAInput = {
  pods?: InputEntity[];
  services?: InputEntity[];
  nodes?: InputEntity[];
  timestamp?: string;
};

type ServiceNode = {
  name: string;
  selfIssue: boolean;
  dependencyIssue: boolean;
  metrics: {
    cpu: number;
    memory: number;
    latency: number;
    restartCount: number;
  };
  logs: string[];
  events: string[];
  timestamp: string | null;
};

type EdgeInfo = {
  confidence: number;
  reasons: string[];
};

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') return [value];
  return [];
}

function normalizeServiceName(value: string): string {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/:\d+$/, '')
    .replace(/\.svc\.cluster\.local$/, '')
    .replace(/\s*\(.*$/, '')
    .replace(/\s*\[.*$/, '')
    .replace(/\s+.*/, '')
    .split('.')[0]
    .replace(/-[a-f0-9]{8,10}-[a-z0-9]{5}$/i, '')
    .replace(/-\d+$/, '')
    .replace(/[^a-z0-9-]/g, '');
}

function coerceBooleanIssue(entity: InputEntity): { selfIssue: boolean; dependencyIssue: boolean } {
  const s = String(entity.status || '').toLowerCase();
  const statusFailed =
    s.includes('fail') ||
    s.includes('crash') ||
    s.includes('error') ||
    s.includes('oom') ||
    s.includes('backoff');

  return {
    selfIssue: Boolean(entity.selfIssue) || statusFailed,
    dependencyIssue: Boolean(entity.dependencyIssue),
  };
}

function normalizeInput(input: RCAInput): ServiceNode[] {
  const all = [...(input.services || []), ...(input.pods || []), ...(input.nodes || [])];
  const byName = new Map<string, ServiceNode>();

  for (const item of all) {
    const rawName = item.service || item.name || item.pod || '';
    const name = normalizeServiceName(rawName);
    if (!name) continue;

    const issue = coerceBooleanIssue(item);
    const existing = byName.get(name);

    if (!existing) {
      byName.set(name, {
        name,
        selfIssue: issue.selfIssue,
        dependencyIssue: issue.dependencyIssue,
        metrics: {
          cpu: Number(item.metrics?.cpu || 0),
          memory: Number(item.metrics?.memory || 0),
          latency: Number(item.metrics?.latency || 0),
          restartCount: Number(item.metrics?.restartCount || 0),
        },
        logs: toStringArray(item.logs),
        events: toStringArray(item.events),
        timestamp: item.timestamp || input.timestamp || null,
      });
      continue;
    }

    existing.selfIssue = existing.selfIssue || issue.selfIssue;
    existing.dependencyIssue = existing.dependencyIssue || issue.dependencyIssue;
    existing.metrics = {
      cpu: Math.max(existing.metrics.cpu, Number(item.metrics?.cpu || 0)),
      memory: Math.max(existing.metrics.memory, Number(item.metrics?.memory || 0)),
      latency: Math.max(existing.metrics.latency, Number(item.metrics?.latency || 0)),
      restartCount: Math.max(existing.metrics.restartCount, Number(item.metrics?.restartCount || 0)),
    };
    existing.logs = [...existing.logs, ...toStringArray(item.logs)];
    existing.events = [...existing.events, ...toStringArray(item.events)];
    if (!existing.timestamp && item.timestamp) existing.timestamp = item.timestamp;
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function addEdge(
  edges: Map<string, Map<string, EdgeInfo>>,
  from: string,
  to: string,
  confidence: number,
  reason: string
) {
  if (!from || !to || from === to) return;
  if (!edges.has(from)) edges.set(from, new Map<string, EdgeInfo>());
  const targetMap = edges.get(from)!;
  const existing = targetMap.get(to);
  if (!existing) {
    targetMap.set(to, { confidence, reasons: [reason] });
    return;
  }
  existing.confidence = Math.max(existing.confidence, confidence);
  if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
}

function inferEdges(nodes: ServiceNode[]): Map<string, Map<string, EdgeInfo>> {
  const edges = new Map<string, Map<string, EdgeInfo>>();
  const names = new Set(nodes.map((n) => n.name));

  const connectionRegexes = [
    /error\s+connecting\s+to\s+([a-z0-9-_.]+)/gi,
    /failed\s+to\s+connect\s+to\s+([a-z0-9-_.]+)/gi,
    /connection\s+refused\s+(?:to\s+)?([a-z0-9-_.]+)/gi,
    /timeout\s+(?:while\s+connecting\s+to\s+)?([a-z0-9-_.]+)/gi,
    /dial\s+tcp\s+([a-z0-9-_.]+)/gi,
    /calling\s+([a-z0-9-_.]+)/gi,
  ];

  for (const node of nodes) {
    const corpus = [...node.logs, ...node.events].join('\n').toLowerCase();
    for (const rx of connectionRegexes) {
      for (const match of corpus.matchAll(rx)) {
        const target = normalizeServiceName(match[1] || '');
        if (target && names.has(target)) {
          addEdge(edges, node.name, target, 0.9, 'log-connection');
        }
      }
    }
  }

  // Timing correlation: dependencyIssue service failing shortly after selfIssue service.
  const withTs = nodes
    .map((n) => ({
      ...n,
      ms: n.timestamp ? Date.parse(n.timestamp) : Number.NaN,
    }))
    .filter((n) => Number.isFinite(n.ms));

  for (const downstream of withTs) {
    if (!downstream.dependencyIssue) continue;
    for (const upstream of withTs) {
      if (!upstream.selfIssue || upstream.name === downstream.name) continue;
      const delta = downstream.ms - upstream.ms;
      if (delta >= 0 && delta <= 5 * 60 * 1000) {
        addEdge(edges, downstream.name, upstream.name, 0.62, 'timing-correlation');
      }
    }
  }

  // Naming inference fallback (low confidence).
  const isFrontend = (n: string) => /frontend|web|ui|gateway|ingress/.test(n);
  const isApi = (n: string) => /api|backend|service/.test(n);
  const isCoreData = (n: string) => /db|database|postgres|mysql|mongo|redis|cache|storage|auth/.test(n);

  for (const a of nodes) {
    for (const b of nodes) {
      if (a.name === b.name) continue;
      if (isFrontend(a.name) && isApi(b.name)) addEdge(edges, a.name, b.name, 0.35, 'naming-pattern');
      if (isApi(a.name) && isCoreData(b.name)) addEdge(edges, a.name, b.name, 0.4, 'naming-pattern');
    }
  }

  return edges;
}

function buildReverseAdjacency(edges: Map<string, Map<string, EdgeInfo>>): Map<string, Set<string>> {
  const rev = new Map<string, Set<string>>();
  for (const [from, targets] of edges.entries()) {
    for (const to of targets.keys()) {
      if (!rev.has(to)) rev.set(to, new Set<string>());
      rev.get(to)!.add(from);
    }
  }
  return rev;
}

function detectFailureType(node: ServiceNode): RCAFailureType {
  const text = [...node.events, ...node.logs].join(' ').toLowerCase();
  if (text.includes('crashloopbackoff')) return 'CrashLoop';
  if (text.includes('oomkilled') || text.includes('out of memory')) return 'Memory';
  if (
    text.includes('connection refused') ||
    text.includes('timeout') ||
    text.includes('failed to connect') ||
    text.includes('dial tcp')
  ) {
    return 'DependencyFailure';
  }
  if (node.metrics.latency >= 1000) return 'Latency';
  return 'Unknown';
}

function inferSeverity(service: string, affectedCount: number): RCASeverity {
  const core = /db|database|postgres|mysql|mongo|redis|storage|auth/.test(service);
  if (core || affectedCount >= 4) return 'CRITICAL';
  if (affectedCount >= 2) return 'HIGH';
  if (affectedCount === 1) return 'MEDIUM';
  return 'LOW';
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function computeConfidence(
  node: ServiceNode,
  affectedNodes: string[],
  hasLogEvidence: boolean,
  hasTimingEvidence: boolean,
  failureType: RCAFailureType
): number {
  let score = 0.45;
  if (node.selfIssue) score += 0.2;
  if (affectedNodes.length > 0) score += 0.1;
  if (hasLogEvidence) score += 0.15;
  if (hasTimingEvidence) score += 0.07;
  if (failureType !== 'Unknown') score += 0.08;
  if (node.timestamp) score += 0.05;
  return round2(Math.max(0, Math.min(0.99, score)));
}

function makeIsoTimestamp(value: string | null): string {
  if (!value) return new Date().toISOString();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return new Date().toISOString();
  return new Date(ms).toISOString();
}

function longestChainToRoot(
  root: string,
  reverse: Map<string, Set<string>>,
  candidateSet: Set<string>
): string[] {
  const queue: string[] = [root];
  const dist = new Map<string, number>([[root, 0]]);
  const parent = new Map<string, string>();

  while (queue.length) {
    const current = queue.shift() as string;
    const children = Array.from(reverse.get(current) || []).sort((a, b) => a.localeCompare(b));
    for (const next of children) {
      if (!candidateSet.has(next)) continue;
      if (dist.has(next)) continue;
      dist.set(next, (dist.get(current) || 0) + 1);
      parent.set(next, current);
      queue.push(next);
    }
  }

  let farthest = root;
  let farthestDistance = -1;
  for (const [node, d] of dist.entries()) {
    if (d > farthestDistance || (d === farthestDistance && node.localeCompare(farthest) < 0)) {
      farthest = node;
      farthestDistance = d;
    }
  }

  const chainRootToLeaf: string[] = [];
  let cur = farthest;
  chainRootToLeaf.push(cur);
  while (parent.has(cur)) {
    cur = parent.get(cur)!;
    chainRootToLeaf.push(cur);
  }

  // Required output order: downstream -> ... -> root
  return chainRootToLeaf;
}

function runRCA(input: RCAInput): RCAOutput {
  const nodes = normalizeInput(input);
  if (!nodes.length) return { rootCauses: [] };

  const byName = new Map(nodes.map((n) => [n.name, n]));
  const edges = inferEdges(nodes);
  const reverse = buildReverseAdjacency(edges);

  const selfIssueNodes = nodes.filter((n) => n.selfIssue);

  const roots = selfIssueNodes.filter((n) => {
    const upstream = edges.get(n.name);
    if (!upstream) return true;
    for (const [depName, info] of upstream.entries()) {
      const dep = byName.get(depName);
      if (!dep) continue;
      if (!dep.selfIssue) continue;
      if (info.confidence >= 0.6) return false;
    }
    return true;
  });

  const rootList = roots.length
    ? roots
    : selfIssueNodes
        .slice()
        .sort((a, b) => {
          const ta = a.timestamp ? Date.parse(a.timestamp) : Number.MAX_SAFE_INTEGER;
          const tb = b.timestamp ? Date.parse(b.timestamp) : Number.MAX_SAFE_INTEGER;
          if (ta !== tb) return ta - tb;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 1);

  const outputs: RCARootCause[] = rootList.map((rootNode) => {
    const impacted = new Set<string>();
    const queue: string[] = [rootNode.name];
    const seen = new Set<string>([rootNode.name]);

    while (queue.length) {
      const current = queue.shift() as string;
      const dependents = Array.from(reverse.get(current) || []).sort((a, b) => a.localeCompare(b));
      for (const dep of dependents) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        const depNode = byName.get(dep);
        if (depNode && (depNode.dependencyIssue || depNode.selfIssue)) {
          impacted.add(dep);
          queue.push(dep);
        }
      }
    }

    const chainNodes = longestChainToRoot(rootNode.name, reverse, impacted);
    const failureChain = chainNodes;
    const affectedNodes = Array.from(impacted)
      .filter((n) => n !== rootNode.name)
      .sort((a, b) => a.localeCompare(b));

    const edgeReasons = new Set<string>();
    for (const nodeName of affectedNodes) {
      const deps = edges.get(nodeName);
      const info = deps?.get(rootNode.name);
      if (info) info.reasons.forEach((r) => edgeReasons.add(r));
    }

    const failureType = detectFailureType(rootNode);
    const severity = inferSeverity(rootNode.name, affectedNodes.length);
    const confidence = computeConfidence(
      rootNode,
      affectedNodes,
      edgeReasons.has('log-connection'),
      edgeReasons.has('timing-correlation'),
      failureType
    );

    return {
      service: rootNode.name,
      failureChain,
      affectedNodes,
      dependencyDepth: failureChain.length,
      failureType,
      severity,
      timestamp: makeIsoTimestamp(rootNode.timestamp || input.timestamp || null),
      confidence,
      reasoning:
        affectedNodes.length > 0
          ? `${rootNode.name} shows direct self-failure signals and upstream evidence indicates cascading impact on ${affectedNodes.join(', ')}.`
          : `${rootNode.name} has direct self-failure signals with no stronger upstream failing dependency evidence.`,
    };
  });

  const severityRank: Record<RCASeverity, number> = {
    CRITICAL: 4,
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
  };

  outputs.sort((a, b) => {
    const s = severityRank[b.severity] - severityRank[a.severity];
    if (s !== 0) return s;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.service.localeCompare(b.service);
  });

  return { rootCauses: outputs };
}

async function metricsToInput(): Promise<RCAInput> {
  const response = await fetch('http://localhost:5555/api/metrics', { cache: 'no-store' });
  if (!response.ok) {
    return { pods: [] };
  }

  const data = (await response.json()) as {
    pods?: Array<{
      name?: string;
      status?: string;
      cpu?: number;
      memory?: number;
      latency?: number;
      restartCount?: number;
      logs?: string[] | string;
      events?: string[] | string;
      timestamp?: string;
    }>;
    timestamp?: string;
  };

  return {
    timestamp: data.timestamp,
    pods: (data.pods || []).map((p) => {
      const status = String(p.status || '');
      const lowered = status.toLowerCase();
      return {
        name: p.name,
        status,
        selfIssue:
          lowered.includes('fail') ||
          lowered.includes('crash') ||
          lowered.includes('oom') ||
          lowered.includes('error') ||
          lowered.includes('backoff'),
        dependencyIssue: false,
        metrics: {
          cpu: Number(p.cpu || 0),
          memory: Number(p.memory || 0),
          latency: Number(p.latency || 0),
          restartCount: Number(p.restartCount || 0),
        },
        logs: p.logs,
        events: p.events,
        timestamp: p.timestamp || data.timestamp,
      } as InputEntity;
    }),
  };
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as RCAInput;
    return NextResponse.json(runRCA(input));
  } catch {
    return NextResponse.json({ rootCauses: [] });
  }
}

export async function GET() {
  try {
    const inferredInput = await metricsToInput();
    return NextResponse.json(runRCA(inferredInput));
  } catch {
    return NextResponse.json({ rootCauses: [] });
  }
}
