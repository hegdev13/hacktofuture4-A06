"use client";

import React, { useMemo, useEffect, useState } from "react";
import { AlertCircle, CheckCircle, Zap } from "lucide-react";

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
  pod: Pod;
}

export function DependencyGraphVisual({ pods }: DependencyGraphVisualProps) {
  const [positions, setPositions] = useState<NodePosition[]>([]);
  const svgRef = React.useRef<SVGSVGElement>(null);

  // Calculate node positions - arrange in hierarchy
  const calculatePositions = (podsData: Pod[]): NodePosition[] => {
    const width = 800;
    const height = 500;
    const margin = 60;

    // Find root pods (no dependents)
    const dependencyCount = new Map<string, number>();
    podsData.forEach((pod) => {
      dependencyCount.set(pod.id, 0);
    });

    podsData.forEach((pod) => {
      if (pod.dependsOn) {
        pod.dependsOn.forEach((depId) => {
          dependencyCount.set(depId, (dependencyCount.get(depId) || 0) + 1);
        });
      }
    });

    // Assign levels
    const levels = new Map<string, number>();
    const visited = new Set<string>();

    const assignLevel = (podId: string): number => {
      if (visited.has(podId)) {
        return levels.get(podId) || 0;
      }
      visited.add(podId);

      const pod = podsData.find((p) => p.id === podId);
      if (!pod || !pod.dependsOn || pod.dependsOn.length === 0) {
        levels.set(podId, 0);
        return 0;
      }

      const maxDepLevel = Math.max(...pod.dependsOn.map((depId) => assignLevel(depId)));
      levels.set(podId, maxDepLevel + 1);
      return maxDepLevel + 1;
    };

    podsData.forEach((pod) => {
      assignLevel(pod.id);
    });

    // Group by level
    const levelGroups = new Map<number, Pod[]>();
    podsData.forEach((pod) => {
      const level = levels.get(pod.id) || 0;
      if (!levelGroups.has(level)) {
        levelGroups.set(level, []);
      }
      levelGroups.get(level)!.push(pod);
    });

    // Calculate positions
    const nodePositions: NodePosition[] = [];
    const maxLevel = Math.max(...Array.from(levelGroups.keys()));
    const availableHeight = height - 2 * margin;
    const levelHeight = availableHeight / (maxLevel + 1);

    levelGroups.forEach((levelPods, level) => {
      const availableWidth = width - 2 * margin;
      const podWidth = availableWidth / (levelPods.length + 1);

      levelPods.forEach((pod, index) => {
        nodePositions.push({
          id: pod.id,
          x: margin + (index + 1) * podWidth,
          y: margin + level * levelHeight,
          pod,
        });
      });
    });

    return nodePositions;
  };

  // Update positions when pods change
  useEffect(() => {
    setPositions(calculatePositions(pods));
  }, [pods]);

  const getNodeColor = (pod: Pod) => {
    if (pod.status === "running") {
      return { fill: "#10b981", stroke: "#059669", text: "#ecfdf5" };
    } else if (pod.status === "failed") {
      return { fill: "#ef4444", stroke: "#dc2626", text: "#fef2f2" };
    } else {
      return { fill: "#f59e0b", stroke: "#d97706", text: "#fffbeb" };
    }
  };

  const isRootCause = (podId: string) => {
    const pod = pods.find((p) => p.id === podId);
    // Use RCA failureType if available, otherwise fall back to old logic
    if (pod?.failureType === "root-cause") return true;
    if (!pod || pod.status !== "failed") return false;
    // Fallback logic
    const dependents = pods.filter((p) => p.dependencies?.includes(podId));
    return dependents.some((d) => d.status === "failed");
  };

  const failedPods = pods.filter((p) => p.status !== "running");
  const hasIssues = failedPods.length > 0;

  return (
    <div className="w-full bg-gradient-to-b from-slate-950 to-slate-900 border border-slate-800/50 rounded-xl p-6 shadow-2xl">
      {/* Header */}
      <div className="space-y-3 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-br from-purple-900 to-purple-800 rounded-lg">
              <svg
                className="w-5 h-5 text-purple-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.5a2 2 0 00-1 3.773A2 2 0 0013 13h-2.5a2 2 0 00-1-3.773V5a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-white">Dependency Graph</h3>
          </div>
          {hasIssues && (
            <div className="flex items-center gap-2 px-3 py-1 bg-red-900/30 border border-red-700/50 rounded-full animate-pulse">
              <AlertCircle className="w-4 h-4 text-red-400" />
              <span className="text-sm font-semibold text-red-300">Issues Detected</span>
            </div>
          )}
        </div>

        <p className="text-sm text-gray-300">
          <span className="text-red-300 font-semibold">{pods.filter((p) => p.status === "failed").length} failed</span>,{" "}
          <span className="text-amber-300 font-semibold">{pods.filter((p) => p.status === "pending").length} pending</span>,{" "}
          <span className="text-emerald-300 font-semibold">{pods.filter((p) => p.status === "running").length} healthy</span>
        </p>
      </div>

      {/* Graph visualization */}
      <div className="bg-slate-950/50 rounded-lg border border-slate-800/30 overflow-hidden">
        <svg
          ref={svgRef}
          className="w-full"
          style={{ minHeight: "500px", background: "linear-gradient(135deg, rgba(15,23,42,0.5) 0%, rgba(30,41,59,0.5) 100%)" }}
          viewBox="0 0 800 500"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Draw edges (dependency lines) */}
          <g>
            {pods.map((pod) => {
              if (!pod.dependsOn) return null;

              return pod.dependsOn.map((depId) => {
                const fromNode = positions.find((n) => n.id === pod.id);
                const toNode = positions.find((n) => n.id === depId);

                if (!fromNode || !toNode) return null;

                const isFailed = pod.status === "failed" || pods.find((p) => p.id === depId)?.status === "failed";
                const strokeColor = isFailed ? "#ef4444" : "#64748b";
                const strokeWidth = isFailed ? "2" : "1.5";

                return (
                  <line
                    key={`${pod.id}-${depId}`}
                    x1={fromNode.x}
                    y1={fromNode.y}
                    x2={toNode.x}
                    y2={toNode.y}
                    stroke={strokeColor}
                    strokeWidth={strokeWidth}
                    opacity={isFailed ? "0.8" : "0.4"}
                    markerEnd={isFailed ? "url(#arrowFailed)" : "url(#arrowNormal)"}
                  />
                );
              });
            })}
          </g>

          {/* Arrow markers */}
          <defs>
            <marker
              id="arrowNormal"
              markerWidth="10"
              markerHeight="10"
              refX="9"
              refY="3"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L0,6 L9,3 z" fill="#64748b" opacity="0.4" />
            </marker>
            <marker
              id="arrowFailed"
              markerWidth="10"
              markerHeight="10"
              refX="9"
              refY="3"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L0,6 L9,3 z" fill="#ef4444" opacity="0.8" />
            </marker>
          </defs>

          {/* Draw nodes */}
          <g>
            {positions.map((node) => {
              const colors = getNodeColor(node.pod);
              const isFailed = node.pod.status === "failed";
              const isRoot = isRootCause(node.id);

              return (
                <g key={node.id}>
                  {/* Node circle */}
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r="28"
                    fill={colors.fill}
                    stroke={colors.stroke}
                    strokeWidth="2"
                    className={isFailed ? "animate-pulse" : ""}
                  />

                  {/* Root cause indicator ring */}
                  {isRoot && (
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r="36"
                      fill="none"
                      stroke="#dc2626"
                      strokeWidth="2"
                      strokeDasharray="4,4"
                      opacity="0.6"
                    />
                  )}

                  {/* Node label */}
                  <text
                    x={node.x}
                    y={node.y}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="text-xs font-bold"
                    fill={colors.text}
                    style={{
                      pointerEvents: "none",
                      textShadow: `0 0 3px ${colors.fill}`,
                    }}
                  >
                    {node.pod.name.split("-")[0].substring(0, 3).toUpperCase()}
                  </text>

                  {/* Tooltip on hover */}
                  <title>{`${node.pod.name} - ${node.pod.status}`}</title>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {/* Legend */}
      <div className="grid grid-cols-3 gap-3 mt-6 p-3 bg-slate-900/50 rounded-lg border border-slate-800/50 text-xs">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-full bg-emerald-500 border border-emerald-600"></div>
          <span className="text-gray-400">Running</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-full bg-red-500 border border-red-600"></div>
          <span className="text-gray-400">Failed</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-full bg-amber-500 border border-amber-600"></div>
          <span className="text-gray-400">Pending</span>
        </div>
      </div>

      {/* Info section */}
      <div className="mt-4 bg-blue-900/20 border border-blue-700/30 rounded-lg p-3">
        <p className="text-xs text-blue-300">
          💡 <strong>Updates every 5 seconds</strong> — Solid lines show failed dependencies,
          dashed rings indicate root cause pods
        </p>
      </div>

      {/* Pod details list */}
      {hasIssues && (
        <div className="mt-6">
          <p className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-3">
            🔴 Affected Pods
          </p>
          <div className="space-y-2">
            {failedPods.map((pod) => (
              <div
                key={pod.id}
                className="flex items-center justify-between p-3 bg-slate-900/50 rounded-lg border border-slate-800/50 hover:border-slate-700/50 transition-colors"
              >
                <div className="flex items-center gap-3 flex-1">
                  {pod.status === "failed" ? (
                    <AlertCircle className="w-4 h-4 text-red-400 animate-pulse" />
                  ) : (
                    <Zap className="w-4 h-4 text-amber-400" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white truncate">{pod.name}</p>
                    {pod.message && (
                      <p className="text-xs text-gray-400 truncate">{pod.message}</p>
                    )}
                  </div>
                </div>
                <span
                  className={`px-2 py-1 rounded text-xs font-medium ${
                    pod.status === "failed"
                      ? "bg-red-900/30 text-red-300"
                      : "bg-amber-900/30 text-amber-300"
                  }`}
                >
                  {pod.status === "failed" ? "Failed" : "Pending"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
