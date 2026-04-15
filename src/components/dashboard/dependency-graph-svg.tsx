'use client';

import { useState, useMemo } from 'react';

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
  isRootCause: boolean;
  nodeType: string;
  x: number;
  y: number;
  column: 'source' | 'root' | 'downstream';
}

const DependencyGraphSVG = ({
  pods,
  onNodeClick,
  width = 1200,
  height = 800,
}: DependencyGraphSVGProps) => {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const podByName = useMemo(() => {
    return new Map(pods.map((p) => [p.name, p]));
  }, [pods]);

  const handleNodeClick = (podName: string) => {
    setSelectedNode(podName);
    onNodeClick?.(podName);
  };

  const { rootName, impactedNames } = useMemo(() => {
    const effectiveRoot =
      pods.find((p) => p.isRootCause) ||
      pods.find((p) => p.status === 'FAILED') ||
      pods[0];

    const currentRootName = effectiveRoot?.name;
    const dependents = new Map<string, string[]>();
    for (const pod of pods) {
      for (const dep of pod.dependsOn || []) {
        const list = dependents.get(dep) || [];
        list.push(pod.name);
        dependents.set(dep, list);
      }
    }

    const descendants = new Set<string>();
    if (currentRootName) {
      const queue = [...(dependents.get(currentRootName) || [])];
      while (queue.length) {
        const name = queue.shift() as string;
        if (descendants.has(name)) continue;
        descendants.add(name);
        for (const next of dependents.get(name) || []) {
          queue.push(next);
        }
      }
    }

    return { rootName: currentRootName, impactedNames: descendants };
  }, [pods]);

  // Color mapping: root/impacted=coral-red, system=blue, healthy downstream=teal
  const getNodeColor = (pod: Pod): string => {
    if (pod.name === rootName || pod.isRootCause || pod.status === 'FAILED') return '#FF6B6B';
    if (impactedNames.has(pod.name)) return '#FF6B6B';
    if (pod.nodeType === 'system') return '#3B82F6';
    if (pod.status === 'RUNNING' || pod.status === 'HEALTHY') return '#14B8A6';
    return '#14B8A6';
  };

  const getStatusText = (pod: Pod): string => {
    return pod.name === rootName || pod.isRootCause ? 'ROOT CAUSE' : 'RUNNING';
  };

  // Layout calculation
  const layout = useMemo(() => {
    const layoutNodes: LayoutNode[] = [];
    const effectiveRoot =
      pods.find((p) => p.isRootCause) ||
      pods.find((p) => p.status === 'FAILED') ||
      pods[0];

    if (!effectiveRoot) return layoutNodes;

    const rootPodName = effectiveRoot.name;

    // Source/left = direct dependencies of root only (cleaner visual topology)
    const directSourceSet = new Set((effectiveRoot.dependsOn || []).filter((name) => name !== rootPodName));

    // Downstream/right = everything else except root and direct sources
    const sourcePods = pods.filter((p) => directSourceSet.has(p.name));
    const downstreamPods = pods.filter((p) => p.name !== rootPodName && !directSourceSet.has(p.name));

    const columnWidth = width / 3;
    const nodeHeight = 60;
    const nodeWidth = 140;
    const spacing = 75;
    const topPadding = 40;
    const bottomPadding = 60;

    const maxRows = Math.max(sourcePods.length, downstreamPods.length, 1);
    const minGraphHeight = topPadding + bottomPadding + maxRows * spacing + nodeHeight;
    const effectiveHeight = Math.max(height, minGraphHeight);

    // Position root cause in center
    layoutNodes.push({
      name: effectiveRoot.name,
      status: effectiveRoot.status,
      isRootCause: true,
      nodeType: effectiveRoot.nodeType || 'compute',
      x: columnWidth + (columnWidth - nodeWidth) / 2,
      y: effectiveHeight / 2 - nodeHeight / 2,
      column: 'root',
    });

    // Position source pods on left
    const sourceStartY = Math.max(topPadding, (effectiveHeight - sourcePods.length * spacing) / 2);
    sourcePods.forEach((pod, idx) => {
      layoutNodes.push({
        name: pod.name,
        status: pod.status,
        isRootCause: false,
        nodeType: pod.nodeType || 'compute',
        x: (columnWidth - nodeWidth) / 2,
        y: sourceStartY + idx * spacing,
        column: 'source',
      });
    });

    // Position downstream pods on right (one per row)
    const downstreamStartY = topPadding;
    downstreamPods.forEach((pod, idx) => {
      layoutNodes.push({
        name: pod.name,
        status: pod.status,
        isRootCause: false,
        nodeType: pod.nodeType || 'compute',
        x: columnWidth * 2 + (columnWidth - nodeWidth) / 2,
        y: downstreamStartY + idx * spacing,
        column: 'downstream',
      });
    });

    return layoutNodes;
  }, [pods, width, height]);

  const renderHeight = useMemo(() => {
    if (!layout.length) return height;
    const maxY = Math.max(...layout.map((n) => n.y));
    return Math.max(height, maxY + 120);
  }, [layout, height]);

  // Draw connection arrows
  const connections = useMemo(() => {
    const links: Array<{
      d: string;
      fromPod: string;
      toPod: string;
    }> = [];

    const nodeMap = new Map(layout.map((n) => [n.name, n]));
    const rootNode = layout.find((n) => n.isRootCause) || layout.find((n) => n.column === 'root');
    if (!rootNode) return links;

    const makeCurve = (x1: number, y1: number, x2: number, y2: number) => {
      const dx = Math.max(80, Math.abs(x2 - x1) * 0.35);
      const c1x = x1 + dx;
      const c2x = x2 - dx;
      return `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`;
    };

    // Clean structured links: source -> root
    layout
      .filter((n) => n.column === 'source')
      .forEach((sourceNode) => {
        const x1 = sourceNode.x + 140;
        const y1 = sourceNode.y + 30;
        const x2 = rootNode.x;
        const y2 = rootNode.y + 30;
        links.push({
          d: makeCurve(x1, y1, x2, y2),
          fromPod: sourceNode.name,
          toPod: rootNode.name,
        });
      });

    // Clean structured links: root -> downstream
    layout
      .filter((n) => n.column === 'downstream')
      .forEach((downNode) => {
        const x1 = rootNode.x + 140;
        const y1 = rootNode.y + 30;
        const x2 = downNode.x;
        const y2 = downNode.y + 30;
        links.push({
          d: makeCurve(x1, y1, x2, y2),
          fromPod: rootNode.name,
          toPod: downNode.name,
        });
      });

    return links;
  }, [layout]);

  const nodeWidth = 140;
  const nodeHeight = 60;

  return (
    <div className="w-full h-full bg-gray-50 rounded-lg p-4 overflow-auto">
      <svg
        width={width}
        height={renderHeight}
        className="border border-gray-300 rounded bg-white shadow-sm"
        viewBox={`0 0 ${width} ${renderHeight}`}
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

        <rect width={width} height={renderHeight} fill="url(#grid)" />

        {/* Connection lines (dashed arrows) */}
        {connections.map((conn, idx) => (
          <g key={`connection-${idx}`}>
            <path
              d={conn.d}
              fill="none"
              stroke="#64748B"
              strokeWidth="2"
              strokeDasharray="6,5"
              markerEnd="url(#arrowDashed)"
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
                rx="8"
                className="transition-all"
              />

              {/* Node label */}
              <text
                x={node.x + nodeWidth / 2}
                y={node.y + 22}
                textAnchor="middle"
                fill="white"
                fontSize="13"
                fontWeight="600"
                className="pointer-events-none"
              >
                {node.name.length > 16
                  ? node.name.substring(0, 13) + '...'
                  : node.name}
              </text>

              {/* Status tag */}
              <g>
                <rect
                  x={node.x + 4}
                  y={node.y + nodeHeight - 22}
                  width={nodeWidth - 8}
                  height="18"
                  fill="rgba(0,0,0,0.2)"
                  rx="4"
                />
                <text
                  x={node.x + nodeWidth / 2}
                  y={node.y + nodeHeight - 8}
                  textAnchor="middle"
                  fill="white"
                  fontSize="10"
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
          Kubernetes Dependency Graph
        </text>

        {/* Legend */}
        <g transform={`translate(20, ${renderHeight - 90})`}>
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
            { color: '#FF6B6B', label: 'Root Cause / Impacted' },
            { color: '#14B8A6', label: 'Healthy Service' },
            { color: '#3B82F6', label: 'System Pod' },
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

        {/* Layout labels for clarity */}
        <text
          x={width / 6}
          y={renderHeight - 20}
          fontSize="11"
          fill="#9CA3AF"
          textAnchor="middle"
          className="pointer-events-none"
        >
          Source Pods
        </text>
        <text
          x={width / 2}
          y={renderHeight - 20}
          fontSize="11"
          fill="#9CA3AF"
          textAnchor="middle"
          className="pointer-events-none"
        >
          Root Cause
        </text>
        <text
          x={(width * 5) / 6}
          y={renderHeight - 20}
          fontSize="11"
          fill="#9CA3AF"
          textAnchor="middle"
          className="pointer-events-none"
        >
          Downstream Pods
        </text>
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
