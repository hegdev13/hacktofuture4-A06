"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Zap } from "lucide-react";

interface Pod {
  id: string;
  name: string;
  status: "running" | "failed" | "pending";
  failureType?: "healthy" | "root-cause" | "cascading";
  failureReason?: string;
  message?: string;
  dependsOn?: string[];
  dependencies?: string[];
  dependents?: string[];
}

interface DependencyGraphVisualProps {
  pods: Pod[];
}

interface NodePosition {
  id: string;
  x: number;
  y: number;
}

type DragState = {
  id: string;
  offsetX: number;
  offsetY: number;
} | null;

export function DependencyGraphVisual({ pods }: DependencyGraphVisualProps) {
  const width = 1400;
  const height = 800;
  const marginX = 130;
  const marginY = 120;
  const nodeRadius = 92;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [positions, setPositions] = useState<Record<string, NodePosition>>({});
  const [dragging, setDragging] = useState<DragState>(null);

  const clampToCanvas = (x: number, y: number) => ({
    x: Math.max(nodeRadius, Math.min(width - nodeRadius, x)),
    y: Math.max(nodeRadius, Math.min(height - nodeRadius, y)),
  });

  const failedPods = pods.filter((p) => p.status === "failed");
  const pendingPods = pods.filter((p) => p.status === "pending");
  const healthyPods = pods.filter((p) => p.status === "running");
  const hasIssues = failedPods.length + pendingPods.length > 0;

  const rootCauseSet = useMemo(() => {
    const set = new Set<string>();
    for (const pod of pods) {
      if (pod.failureType === "root-cause") {
        set.add(pod.id);
      }
    }

    if (set.size) return set;

    for (const pod of pods) {
      if (pod.status !== "failed") continue;
      const deps = pod.dependsOn ?? [];
      const hasFailedDependency = deps.some((depId) => {
        const dep = pods.find((p) => p.id === depId);
        return dep?.status === "failed";
      });
      if (!hasFailedDependency) set.add(pod.id);
    }

    return set;
  }, [pods]);

  const graph = useMemo(() => {
    const podById = new Map(pods.map((p) => [p.id, p]));
    const memo = new Map<string, number>();
    const active = new Set<string>();

    const levelOf = (id: string): number => {
      if (memo.has(id)) return memo.get(id)!;
      if (active.has(id)) return 0;

      active.add(id);
      const pod = podById.get(id);
      const deps = pod?.dependsOn ?? [];
      const level = deps.length
        ? 1 + Math.max(...deps.map((depId) => (podById.has(depId) ? levelOf(depId) : 0)))
        : 0;
      active.delete(id);
      memo.set(id, level);
      return level;
    };

    for (const pod of pods) levelOf(pod.id);

    const maxLevel = Math.max(0, ...Array.from(memo.values()));
    const byLevel = new Map<number, Pod[]>();
    for (const pod of pods) {
      const lv = memo.get(pod.id) ?? 0;
      if (!byLevel.has(lv)) byLevel.set(lv, []);
      byLevel.get(lv)!.push(pod);
    }

    const builtPositions: NodePosition[] = [];
    for (let level = 0; level <= maxLevel; level += 1) {
      const levelPods = (byLevel.get(level) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      const x =
        maxLevel === 0
          ? width / 2
          : marginX + ((width - marginX * 2) * level) / Math.max(1, maxLevel);
      const bandHeight = height - marginY * 2;
      const gap = bandHeight / Math.max(1, levelPods.length + 1);

      levelPods.forEach((pod, idx) => {
        builtPositions.push({
          id: pod.id,
          ...clampToCanvas(x, marginY + gap * (idx + 1)),
        });
      });
    }

    const positionMap = new Map(builtPositions.map((p) => [p.id, p]));
    const discoveredEdges = pods.flatMap((pod) => {
      const to = positionMap.get(pod.id);
      if (!to) return [];
      return (pod.dependsOn ?? [])
        .map((depId) => {
          const from = positionMap.get(depId);
          if (!from) return null;
          return { from: depId, to: pod.id, synthetic: false };
        })
        .filter((e): e is { from: string; to: string; synthetic: boolean } => Boolean(e));
    });

    let edges = discoveredEdges;
    if (edges.length === 0 && pods.length > 1) {
      const tierOf = (pod: Pod) => {
        const n = pod.name.toLowerCase();
        if (["load-balancer", "ingress", "gateway", "proxy", "traefik", "nginx"].some((k) => n.includes(k))) return 0;
        if (["web", "frontend", "ui", "edge", "client"].some((k) => n.includes(k))) return 1;
        if (["api", "app", "backend", "service", "server", "worker"].some((k) => n.includes(k))) return 2;
        if (["db", "database", "postgres", "mysql", "mongo", "redis", "cache", "kafka", "rabbit", "queue"].some((k) => n.includes(k))) return 3;
        return 2;
      };

      const byTier = new Map<number, Pod[]>();
      for (const pod of pods) {
        const t = tierOf(pod);
        if (!byTier.has(t)) byTier.set(t, []);
        byTier.get(t)!.push(pod);
      }
      for (const [tier, tierPods] of byTier.entries()) {
        byTier.set(
          tier,
          [...tierPods].sort((a, b) => a.name.localeCompare(b.name)),
        );
      }

      const tiers = [...byTier.keys()].sort((a, b) => a - b);
      const inferred: Array<{ from: string; to: string; synthetic: boolean }> = [];

      for (let i = 0; i < tiers.length - 1; i += 1) {
        const current = byTier.get(tiers[i]) ?? [];
        const next = byTier.get(tiers[i + 1]) ?? [];
        if (!current.length || !next.length) continue;

        if (current.length === 1) {
          const source = current[0].id;
          for (const target of next) {
            inferred.push({ from: source, to: target.id, synthetic: true });
          }
          continue;
        }

        if (next.length === 1) {
          const target = next[0].id;
          for (const source of current) {
            inferred.push({ from: source.id, to: target, synthetic: true });
          }
          continue;
        }

        // Map each downstream node to a proportional upstream node for stable, non-random links.
        for (let j = 0; j < next.length; j += 1) {
          const sourceIdx = Math.floor((j * current.length) / next.length);
          inferred.push({ from: current[sourceIdx].id, to: next[j].id, synthetic: true });
        }
      }

      // Final fallback if all nodes landed in same tier.
      if (inferred.length === 0) {
        const sorted = [...pods].sort((a, b) => a.name.localeCompare(b.name));
        for (let i = 0; i < sorted.length - 1; i += 1) {
          inferred.push({ from: sorted[i].id, to: sorted[i + 1].id, synthetic: true });
        }
      }

      edges = inferred;
    }

    return { positions: builtPositions, edges, podById };
  }, [pods, height, marginX, marginY, width]);

  useEffect(() => {
    setPositions((prev) => {
      const next: Record<string, NodePosition> = {};
      for (const node of graph.positions) {
        const prior = prev[node.id] ?? node;
        next[node.id] = {
          ...node,
          ...clampToCanvas(prior.x, prior.y),
        };
      }
      return next;
    });
  }, [graph.positions]);

  const statusStyle = (pod: Pod) => {
    if (pod.failureType === "root-cause") {
      return {
        node: "#f8e0dc",
        border: "#b4532a",
        text: "#5f2d1d",
        accent: "#ef4444",
      };
    }
    if (pod.failureType === "cascading") {
      return {
        node: "#fbefcf",
        border: "#c1862a",
        text: "#78350f",
        accent: "#d97706",
      };
    }
    if (pod.status === "failed") {
      return {
        node: "#fee2e2",
        border: "#ef4444",
        text: "#7f1d1d",
        accent: "#ef4444",
      };
    }
    if (pod.status === "pending") {
      return {
        node: "#fef3c7",
        border: "#d97706",
        text: "#78350f",
        accent: "#d97706",
      };
    }
    return {
      node: "#dae4f0",
      border: "#2f64b2",
      text: "#1f497a",
      accent: "#2f64b2",
    };
  };

  const toSvgPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * width;
    const y = ((clientY - rect.top) / rect.height) * height;
    return { x, y };
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging) return;
    const point = toSvgPoint(e.clientX, e.clientY);
    setPositions((prev) => {
      const curr = prev[dragging.id];
      if (!curr) return prev;

      const nextX = Math.max(nodeRadius, Math.min(width - nodeRadius, point.x - dragging.offsetX));
      const nextY = Math.max(nodeRadius, Math.min(height - nodeRadius, point.y - dragging.offsetY));

      return {
        ...prev,
        [dragging.id]: {
          ...curr,
          x: nextX,
          y: nextY,
        },
      };
    });
  };

  const onNodePointerDown = (e: React.PointerEvent<SVGGElement>, id: string) => {
    const node = positions[id];
    if (!node) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const point = toSvgPoint(e.clientX, e.clientY);
    setDragging({ id, offsetX: point.x - node.x, offsetY: point.y - node.y });
  };

  const shortName = (name: string) => {
    if (name.length <= 22) return [name];
    const parts = name.split("-");
    if (parts.length > 1) {
      return [parts.slice(0, 2).join("-"), parts.slice(2).join("-") || "service"];
    }
    return [name.slice(0, 20), `${name.slice(20, 38)}...`];
  };

  const getEdgeLine = (source: NodePosition, target: NodePosition) => {
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const ux = dx / dist;
    const uy = dy / dist;

    return {
      x1: source.x + ux * nodeRadius,
      y1: source.y + uy * nodeRadius,
      x2: target.x - ux * nodeRadius,
      y2: target.y - uy * nodeRadius,
    };
  };

  return (
    <div className="w-full rounded-2xl border border-[#d7dbe1] bg-[#f7f7f8] p-6 shadow-[0_16px_34px_rgba(63,74,83,0.12)]">
      <div className="mb-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h3 className="text-xl font-bold text-[#1f2b33]">Dependency Graph</h3>
          </div>
          {hasIssues && (
            <div className="flex items-center gap-2 rounded-full border border-[#e88e8e] bg-[#fbe4e4] px-3 py-1.5">
              <AlertCircle className="h-4 w-4 text-[#b91c1c]" />
              <span className="text-sm font-semibold text-[#b91c1c]">Issues Detected</span>
            </div>
          )}
        </div>

        <p className="text-sm text-[#44525d]">
          <span className="font-semibold text-[#b91c1c]">{failedPods.length} failed</span>,{" "}
          <span className="font-semibold text-[#92400e]">{pendingPods.length} pending</span>,{" "}
          <span className="font-semibold text-[#166534]">{healthyPods.length} healthy</span>
        </p>

        <div className="flex flex-wrap gap-3">
          <div className="rounded-full border border-[#d8c8cb] bg-[#f8d7da] px-4 py-2 text-sm font-semibold text-[#7f1d1d]">Root cause</div>
          <div className="rounded-full border border-[#e6d8b4] bg-[#fbefcf] px-4 py-2 text-sm font-semibold text-[#78350f]">Cascading</div>
          <div className="rounded-full border border-[#d8dce1] bg-[#dae4f0] px-4 py-2 text-sm font-semibold text-[#1f497a]">Healthy</div>
          <div className="rounded-full border border-slate-300 bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">Drag nodes to rearrange</div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-[#d7dbe1] bg-[#efeff1] p-2">
        <svg
          ref={svgRef}
          className="block w-full"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerMove={onPointerMove}
          onPointerUp={() => setDragging(null)}
          onPointerLeave={() => setDragging(null)}
        >
          <defs>
            <marker
              id="arrowNormal"
              markerWidth="9"
              markerHeight="9"
              refX="8"
              refY="3"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L0,6 L8,3 z" fill="#374151" opacity="0.9" />
            </marker>
            <pattern id="bgGrid" width="28" height="28" patternUnits="userSpaceOnUse">
              <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#d9dde3" strokeWidth="1" />
            </pattern>
          </defs>

          <rect x="0" y="0" width={width} height={height} fill="url(#bgGrid)" />

          {graph.edges.map((edge, idx) => {
            const source = positions[edge.from];
            const target = positions[edge.to];
            if (!source || !target) return null;

            const sourcePod = graph.podById.get(edge.from);
            const targetPod = graph.podById.get(edge.to);
            const line = getEdgeLine(source, target);
            const issue = sourcePod?.failureType !== "healthy" || targetPod?.failureType !== "healthy";

            return (
              <line
                key={`edge-${idx}`}
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                stroke={issue ? "#b0892d" : edge.synthetic ? "#b6b4ae" : "#8f8d87"}
                strokeWidth={issue ? 2.4 : edge.synthetic ? 2.1 : 1.9}
                strokeLinecap="round"
                opacity={0.95}
                markerEnd="url(#arrowNormal)"
              />
            );
          })}

          {pods.map((pod) => {
            const node = positions[pod.id];
            if (!node) return null;
            const style = statusStyle(pod);
            const isRoot = rootCauseSet.has(pod.id) || pod.failureType === "root-cause";
            const lines = shortName(pod.name);

            return (
              <g
                key={pod.id}
                onPointerDown={(e) => onNodePointerDown(e, pod.id)}
                style={{ cursor: dragging?.id === pod.id ? "grabbing" : "grab" }}
              >
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={nodeRadius}
                  fill={style.node}
                  stroke={style.border}
                  strokeWidth={isRoot ? 3.2 : 2}
                />

                <text
                  x={node.x}
                  y={node.y - (lines.length > 1 ? 12 : 0)}
                  textAnchor="middle"
                  className="text-[16px] font-semibold"
                  fill={style.text}
                >
                  {lines.map((line, idx) => (
                    <tspan key={`${pod.id}-line-${idx}`} x={node.x} dy={idx === 0 ? 0 : 22}>
                      {line}
                    </tspan>
                  ))}
                </text>

                {pod.failureType === "root-cause" && (
                  <text
                    x={node.x}
                    y={node.y + 52}
                    textAnchor="middle"
                    className="text-[12px] font-bold uppercase tracking-wider"
                    fill="#7f1d1d"
                  >
                    Root Cause
                  </text>
                )}

                {pod.failureType === "cascading" && (
                  <text
                    x={node.x}
                    y={node.y + 52}
                    textAnchor="middle"
                    className="text-[12px] font-bold uppercase tracking-wider"
                    fill="#92400e"
                  >
                    Cascading
                  </text>
                )}

                <title>{`${pod.name} (${pod.status})`}</title>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-4">
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          Healthy nodes: <span className="font-semibold">{healthyPods.length}</span>
        </div>
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Pending nodes: <span className="font-semibold">{pendingPods.length}</span>
        </div>
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
          Failed nodes: <span className="font-semibold">{failedPods.length}</span>
        </div>
        <div className="rounded-lg border border-orange-300 bg-orange-50 px-3 py-2 text-xs text-orange-800">
          Root causes: <span className="font-semibold">{rootCauseSet.size}</span>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-slate-300 bg-slate-100 p-3">
        <p className="text-xs text-slate-700">
          Architecture view enabled: circular services with directional flow. You can drag any node to inspect paths and clusters.
        </p>
      </div>

      {hasIssues && (
        <div className="mt-6">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
            Impacted Services
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {[...failedPods, ...pendingPods].map((pod) => (
              <div
                key={pod.id}
                className="flex items-center justify-between rounded-lg border border-slate-700/60 bg-slate-900/55 p-3 transition-colors hover:border-slate-500/60"
              >
                <div className="flex items-center gap-3 flex-1">
                  {pod.status === "failed" ? (
                    <AlertCircle className="h-4 w-4 text-red-300" />
                  ) : (
                    <Zap className="h-4 w-4 text-amber-300" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white truncate">{pod.name}</p>
                    {(pod.failureReason || pod.message) && (
                      <p className="truncate text-xs text-gray-400">{pod.failureReason || pod.message}</p>
                    )}
                  </div>
                </div>
                <span
                  className={`px-2 py-1 rounded text-xs font-medium ${
                    pod.failureType === "root-cause" || pod.status === "failed"
                      ? "bg-red-900/30 text-red-300"
                      : "bg-amber-900/30 text-amber-300"
                  }`}
                >
                  {pod.failureType === "root-cause"
                    ? "Root cause"
                    : pod.failureType === "cascading"
                    ? "Cascading"
                    : pod.status === "failed"
                    ? "Failed"
                    : "Pending"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
