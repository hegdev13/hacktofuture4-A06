'use client';

import { useState, useMemo, useEffect, type MouseEvent as ReactMouseEvent } from 'react';

export interface Pod {
  name: string;
  status: 'RUNNING' | 'FAILED' | 'PENDING' | 'HEALTHY';
  isRootCause?: boolean;
  dependsOn?: string[];
  impactedBy?: string[];
  nodeType?: 'gateway' | 'web' | 'compute' | 'storage' | 'system';
}

export interface DependencyGraphSVGProps {
  pods: Pod[];
  onNodeClick?: (podName: string) => void;
  width?: number;
  height?: number;
}

interface LayoutNode {
  name: string;
  status: string;
  nodeType: string;
  x: number;
  y: number;
}

type NodeIssueState = {
  selfIssue: boolean;
  dependencyIssue: boolean;
  color: "green" | "red" | "yellow" | "red-yellow";
};

const DependencyGraphSVG = ({
  pods,
  onNodeClick,
  width = 1200,
  height = 800,
}: DependencyGraphSVGProps) => {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({});
  const [dragging, setDragging] = useState<{ name: string; dx: number; dy: number } | null>(null);

  const nodeMetrics = useMemo(() => {
    const count = Math.max(1, pods.length);
    const densityScale =
      count >= 100 ? 0.5 :
      count >= 70 ? 0.6 :
      count >= 45 ? 0.72 :
      count >= 30 ? 0.82 :
      1;

    const nodeWidth = Math.round(Math.max(72, Math.min(140, 140 * densityScale)));
    const nodeHeight = Math.round(Math.max(38, Math.min(60, 60 * densityScale)));
    const cornerRadius = Math.max(5, Math.round(nodeHeight * 0.14));
    const labelFontSize = Math.max(9, Math.round(nodeHeight * 0.23));
    const statusFontSize = Math.max(8, Math.round(nodeHeight * 0.17));
    const statusBarHeight = Math.max(12, Math.round(nodeHeight * 0.3));
    const labelY = Math.max(16, Math.round(nodeHeight * 0.38));

    return {
      nodeWidth,
      nodeHeight,
      cornerRadius,
      labelFontSize,
      statusFontSize,
      statusBarHeight,
      labelY,
      xPadding: Math.max(18, Math.round(nodeWidth * 0.5)),
      yPadding: Math.max(16, Math.round(nodeHeight * 0.8)),
      minYGap: Math.max(6, Math.round(nodeHeight * 0.16)),
      maxYGap: Math.max(18, Math.round(nodeHeight * 1.1)),
      columnGap: Math.max(8, Math.round(nodeWidth * 0.12)),
    };
  }, [pods.length]);

  const {
    nodeWidth,
    nodeHeight,
    cornerRadius,
    labelFontSize,
    statusFontSize,
    statusBarHeight,
    labelY,
    xPadding,
    yPadding,
    minYGap,
    maxYGap,
    columnGap,
  } = nodeMetrics;

  const podByName = useMemo(() => {
    return new Map(pods.map((p) => [p.name, p]));
  }, [pods]);

  const handleNodeClick = (podName: string) => {
    setSelectedNode(podName);
    onNodeClick?.(podName);
  };

  const resolvedDependencyPairs = useMemo(() => {
    const normalize = (value: string) =>
      value
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/:\d+$/, '')
        .replace(/\.svc\.cluster\.local$/, '')
        .split('.')[0]
        .replace(/[^a-z0-9-]/g, '');

    const nodeNames = new Set(pods.map((p) => p.name));
    const aliasToNodeName = new Map<string, string>();
    for (const pod of pods) {
      const base = normalize(pod.name);
      const compact = base.replace(/-/g, '');
      aliasToNodeName.set(base, pod.name);
      aliasToNodeName.set(compact, pod.name);
      if (base.endsWith('-service')) {
        aliasToNodeName.set(base.replace(/-service$/, 'service'), pod.name);
      }
      if (base.endsWith('service')) {
        aliasToNodeName.set(base.replace(/service$/, '-service'), pod.name);
      }
    }

    const resolveNodeByDependency = (depName: string) => {
      if (nodeNames.has(depName)) return depName;
      const normalized = normalize(depName);
      const compact = normalized.replace(/-/g, '');
      return aliasToNodeName.get(normalized) || aliasToNodeName.get(compact);
    };

    const pairs: Array<{ from: string; to: string }> = [];
    for (const pod of pods) {
      for (const depName of pod.dependsOn || []) {
        const resolved = resolveNodeByDependency(depName);
        if (!resolved || resolved === pod.name) continue;
        pairs.push({ from: pod.name, to: resolved });
      }
    }
    return pairs;
  }, [pods]);

  const issueByNode = useMemo(() => {
    const states = new Map<string, NodeIssueState>();

    for (const pod of pods) {
      states.set(pod.name, {
        selfIssue: pod.status === 'FAILED',
        dependencyIssue: false,
        color: pod.status === 'FAILED' ? 'red' : 'green',
      });
    }

    // Build directional graph (parent -> child) from rendered edges.
    // Cascading should move outward to children, not back to the root.
    const childrenByNode = new Map<string, Set<string>>();
    const ensureChildrenSet = (name: string) => {
      if (!childrenByNode.has(name)) {
        childrenByNode.set(name, new Set<string>());
      }
      return childrenByNode.get(name)!;
    };

    for (const edge of resolvedDependencyPairs) {
      ensureChildrenSet(edge.from).add(edge.to);
    }

    // Propagate cascading state from each failed source independently.
    // This allows a failed node to also become cascading when impacted by
    // another failed node in the same connected dependency region.
    const failedSources = Array.from(states.entries())
      .filter(([, state]) => state.selfIssue)
      .map(([name]) => name);

    for (const source of failedSources) {
      const queue: string[] = [source];
      const visited = new Set<string>([source]);

      while (queue.length) {
        const current = queue.shift() as string;
        const nextNodes = childrenByNode.get(current) || new Set<string>();

        for (const nextNode of nextNodes) {
          if (visited.has(nextNode)) continue;
          visited.add(nextNode);

          const nextState = states.get(nextNode);
          if (nextState && nextNode !== source) {
            nextState.dependencyIssue = true;
          }

          queue.push(nextNode);
        }
      }
    }

    for (const state of states.values()) {
      if (state.selfIssue && state.dependencyIssue) {
        state.color = 'red-yellow';
      } else if (state.selfIssue) {
        state.color = 'red';
      } else if (state.dependencyIssue) {
        state.color = 'yellow';
      } else {
        state.color = 'green';
      }
    }

    return states;
  }, [pods, resolvedDependencyPairs]);

  const getNodeColor = (pod: Pod): string => {
    const issue = issueByNode.get(pod.name);
    if (!issue) return '#14B8A6';
    if (issue.color === 'red') return '#FF6B6B';
    if (issue.color === 'yellow') return '#F59E0B';
    if (issue.color === 'red-yellow') return 'url(#nodeRedYellow)';
    return '#14B8A6';
  };

  const getStatusText = (pod: Pod): string => {
    const issue = issueByNode.get(pod.name);
    if (!issue) return pod.status;
    if (issue.selfIssue && issue.dependencyIssue) return 'FAILED + CASCADE';
    if (issue.selfIssue) return 'FAILED';
    if (issue.dependencyIssue) return 'CASCADING';
    return 'HEALTHY';
  };

  // Sparse layered layout used as initial node positions.
  const baseLayout = useMemo(() => {
    const layoutNodes: LayoutNode[] = [];
    if (!pods.length) return layoutNodes;

    const depsByNode = new Map<string, string[]>();
    const dependentsByNode = new Map<string, string[]>();
    for (const pod of pods) {
      depsByNode.set(pod.name, []);
      dependentsByNode.set(pod.name, []);
    }
    for (const edge of resolvedDependencyPairs) {
      depsByNode.get(edge.from)?.push(edge.to);
      dependentsByNode.get(edge.to)?.push(edge.from);
    }

    const memoDepth = new Map<string, number>();
    const visiting = new Set<string>();

    const depthOf = (node: string): number => {
      if (memoDepth.has(node)) return memoDepth.get(node)!;
      if (visiting.has(node)) return 0;
      visiting.add(node);
      const deps = depsByNode.get(node) || [];
      const depth = deps.length
        ? 1 + Math.max(...deps.map((d) => depthOf(d)))
        : 0;
      visiting.delete(node);
      memoDepth.set(node, depth);
      return depth;
    };

    for (const pod of pods) depthOf(pod.name);

    const maxDepth = Math.max(0, ...Array.from(memoDepth.values()));
    const columns = new Map<number, Pod[]>();
    for (const pod of pods) {
      const depth = memoDepth.get(pod.name) || 0;
      const col = maxDepth - depth;
      const arr = columns.get(col) || [];
      arr.push(pod);
      columns.set(col, arr);
    }

    const sortedCols = Array.from(columns.keys()).sort((a, b) => a - b);

    const availableY = Math.max(1, height - 2 * yPadding);
    const maxNodesPerTrack = Math.max(
      1,
      Math.floor((availableY + minYGap) / (nodeHeight + minYGap))
    );

    const renderedTracks: Pod[][] = [];
    for (const col of sortedCols) {
      const colPods = (columns.get(col) || []).sort((a, b) => {
        const aDeps = depsByNode.get(a.name)?.length || 0;
        const bDeps = depsByNode.get(b.name)?.length || 0;
        if (bDeps !== aDeps) return bDeps - aDeps;
        return a.name.localeCompare(b.name);
      });

      if (colPods.length <= maxNodesPerTrack) {
        renderedTracks.push(colPods);
        continue;
      }

      for (let i = 0; i < colPods.length; i += maxNodesPerTrack) {
        renderedTracks.push(colPods.slice(i, i + maxNodesPerTrack));
      }
    }

    const columnCount = renderedTracks.length;
    const availableX = Math.max(0, width - xPadding * 2 - nodeWidth);
    const stepX = columnCount > 1 ? Math.max(columnGap, availableX / (columnCount - 1)) : 0;

    renderedTracks.forEach((colPods, trackIndex) => {
      const maxGapForHeight = colPods.length > 1
        ? Math.max(minYGap, (height - 2 * yPadding - nodeHeight) / (colPods.length - 1))
        : 0;
      const yGap = colPods.length > 1 ? Math.min(maxYGap, maxGapForHeight) : 0;
      const totalHeight = colPods.length * nodeHeight + Math.max(0, colPods.length - 1) * yGap;
      const startY = Math.max(yPadding, (height - totalHeight) / 2);

      colPods.forEach((pod, idx) => {
        const baseX = columnCount > 1
          ? xPadding + trackIndex * stepX
          : (width - nodeWidth) / 2;
        const baseY = startY + idx * (nodeHeight + yGap);

        layoutNodes.push({
          name: pod.name,
          status: pod.status,
          nodeType: pod.nodeType || 'compute',
          x: baseX,
          y: baseY,
        });
      });
    });

    return layoutNodes;
  }, [pods, height, width, resolvedDependencyPairs, xPadding, yPadding, minYGap, maxYGap, nodeHeight, nodeWidth, columnGap]);

  useEffect(() => {
    setNodePositions((prev) => {
      const next: Record<string, { x: number; y: number }> = {};
      for (const node of baseLayout) {
        const prior = prev[node.name] ?? { x: node.x, y: node.y };
        next[node.name] = {
          x: Math.max(10, Math.min(width - nodeWidth - 10, prior.x)),
          y: Math.max(10, Math.min(height - nodeHeight - 10, prior.y)),
        };
      }
      return next;
    });
  }, [baseLayout, width, height, nodeWidth, nodeHeight]);

  const layout = useMemo(
    () =>
      baseLayout.map((node) => ({
        ...node,
        x: nodePositions[node.name]?.x ?? node.x,
        y: nodePositions[node.name]?.y ?? node.y,
      })),
    [baseLayout, nodePositions]
  );

  const getSvgPoint = (e: ReactMouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = width / rect.width;
    const scaleY = height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const handleSvgMouseMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (!dragging) return;
    const p = getSvgPoint(e);
    const x = Math.max(10, Math.min(width - nodeWidth - 10, p.x - dragging.dx));
    const y = Math.max(10, Math.min(height - nodeHeight - 10, p.y - dragging.dy));
    setNodePositions((prev) => ({
      ...prev,
      [dragging.name]: { x, y },
    }));
  };

  const handleSvgMouseUp = () => {
    if (dragging) setDragging(null);
  };

  // Draw connection arrows
  const connections = useMemo(() => {
    const links: Array<{
      d: string;
      fromPod: string;
      toPod: string;
    }> = [];

    const nodeMap = new Map(layout.map((n) => [n.name, n]));

    const makeCurve = (x1: number, y1: number, x2: number, y2: number) => {
      const dx = Math.max(120, Math.abs(x2 - x1) * 0.42);
      const c1x = x1 + dx;
      const c2x = x2 - dx;
      return `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`;
    };

    // Draw every real dependency edge: A -> B where A dependsOn B.
    for (const edge of resolvedDependencyPairs) {
      const fromNode = nodeMap.get(edge.from);
      const toNode = nodeMap.get(edge.to);
      if (!fromNode || !toNode || toNode.name === fromNode.name) continue;

      const x1 = fromNode.x + nodeWidth;
      const y1 = fromNode.y + nodeHeight / 2;
      const x2 = toNode.x;
      const y2 = toNode.y + nodeHeight / 2;

      links.push({
        d: makeCurve(x1, y1, x2, y2),
        fromPod: fromNode.name,
        toPod: toNode.name,
      });
    }

    return links;
  }, [layout, resolvedDependencyPairs, nodeWidth, nodeHeight]);

  const startDrag = (e: ReactMouseEvent<SVGGElement>, node: LayoutNode) => {
    e.stopPropagation();
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const scaleX = width / rect.width;
    const scaleY = height / rect.height;
    const p = {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
    setDragging({
      name: node.name,
      dx: p.x - node.x,
      dy: p.y - node.y,
    });
  };

  return (
    <div className="w-full bg-gray-50 rounded-lg p-4 overflow-hidden">
      <svg
        width="100%"
        height={height}
        className="block border border-gray-300 rounded bg-white shadow-sm"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseMove={handleSvgMouseMove}
        onMouseUp={handleSvgMouseUp}
        onMouseLeave={handleSvgMouseUp}
      >
        {/* Grid background */}
        <defs>
          <pattern
            id="grid"
            width="40"
            height="40"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 40 0 L 0 0 0 40"
              fill="none"
              stroke="#E5E7EB"
              strokeWidth="0.5"
            />
          </pattern>

          <linearGradient id="nodeRedYellow" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="50%" stopColor="#FF6B6B" />
            <stop offset="50%" stopColor="#F59E0B" />
          </linearGradient>

          {/* Dashed arrow marker */}
          <marker
            id="arrowDashed"
            markerWidth="10"
            markerHeight="10"
            refX="9"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L0,6 L9,3 z" fill="#95A5A6" />
          </marker>
        </defs>

        <rect width={width} height={height} fill="url(#grid)" />

        {/* Connection lines (dashed arrows) */}
        {connections.map((conn, idx) => (
          <g key={`connection-${idx}`}>
            <path
              d={conn.d}
              fill="none"
              stroke="#334155"
              strokeWidth="2.5"
              markerEnd="url(#arrowDashed)"
              opacity="0.75"
            />
          </g>
        ))}

        {/* Nodes */}
        {layout.map(node => {
          const pod = podByName.get(node.name);
          if (!pod) return null;

          const bgColor = getNodeColor(pod);
          const isSelected = selectedNode === node.name;
          const opacity = isSelected ? 1 : 0.85;

          return (
            <g
              key={node.name}
              onMouseDown={(e) => startDrag(e, node)}
              onClick={() => handleNodeClick(node.name)}
              className="cursor-pointer transition-all hover:opacity-100"
              style={{ opacity }}
            >
              {/* Node background with border */}
              <rect
                x={node.x}
                y={node.y}
                width={nodeWidth}
                height={nodeHeight}
                fill={bgColor}
                stroke={isSelected ? '#000' : '#333'}
                strokeWidth={isSelected ? 3 : 2}
                rx={cornerRadius}
                className="transition-all"
              />

              {/* Node label */}
              <text
                x={node.x + nodeWidth / 2}
                y={node.y + labelY}
                textAnchor="middle"
                fill="white"
                fontSize={labelFontSize}
                fontWeight="600"
                className="pointer-events-none"
              >
                {node.name.length > 16
                  ? node.name.substring(0, Math.max(6, Math.floor(nodeWidth / 9))) + '...'
                  : node.name}
              </text>

              {/* Status tag */}
              <g>
                <rect
                  x={node.x + 4}
                  y={node.y + nodeHeight - statusBarHeight - 4}
                  width={nodeWidth - 8}
                  height={statusBarHeight}
                  fill="rgba(0,0,0,0.2)"
                  rx="4"
                />
                <text
                  x={node.x + nodeWidth / 2}
                  y={node.y + nodeHeight - Math.max(4, Math.round(statusBarHeight * 0.24))}
                  textAnchor="middle"
                  fill="white"
                  fontSize={statusFontSize}
                  fontWeight="700"
                  className="pointer-events-none"
                >
                  {getStatusText(
                    pod
                  )}
                </text>
              </g>
            </g>
          );
        })}

        {/* Title */}
        <text
          x={20}
          y={30}
          fontSize="16"
          fontWeight="700"
          fill="#1F2937"
          className="pointer-events-none"
        >
          Kubernetes Pod Dependency Graph
        </text>

        <text
          x={20}
          y={50}
          fontSize="12"
          fontWeight="600"
          fill="#475569"
          className="pointer-events-none"
        >
          {`Nodes: ${pods.length} | Connections: ${connections.length}`}
        </text>

        {/* Legend */}
        <g transform={`translate(20, ${height - 90})`}>
          <text
            x={0}
            y={0}
            fontSize="12"
            fontWeight="600"
            fill="#1F2937"
            className="pointer-events-none"
          >
            Legend:
          </text>

          {/* Legend items */}
          {[
            { color: '#FF6B6B', label: 'Direct Issue (Red)' },
            { color: '#F59E0B', label: 'Cascading Issue (Yellow)' },
            { color: 'url(#nodeRedYellow)', label: 'Direct + Cascading (Red-Yellow)' },
            { color: '#14B8A6', label: 'Healthy (Green)' },
          ].map((item, idx) => (
            <g key={idx} transform={`translate(0, ${(idx + 1) * 20})`}>
              <rect
                x={0}
                y={0}
                width={14}
                height={14}
                fill={item.color}
                rx="2"
              />
              <text
                x={20}
                y={12}
                fontSize="11"
                fill="#374151"
                className="pointer-events-none"
              >
                {item.label}
              </text>
            </g>
          ))}
        </g>
      </svg>

      {/* Info panel */}
      {selectedNode && (
        <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded">
          <h3 className="font-semibold text-blue-900">Selected Pod</h3>
          <p className="text-sm text-blue-800">{selectedNode}</p>
          <button
            onClick={() => setSelectedNode(null)}
            className="mt-2 px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Clear Selection
          </button>
        </div>
      )}
    </div>
  );
};

export default DependencyGraphSVG;
