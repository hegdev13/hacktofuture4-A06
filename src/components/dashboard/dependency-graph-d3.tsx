"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Home, ZoomIn, ZoomOut } from "lucide-react";

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

interface DependencyGraphD3Props {
	pods: Pod[];
}

type NodeT = {
	id: string;
	pod: Pod;
	x: number;
	y: number;
	radius: number;
	labelLines: string[];
};

type LinkT = {
	source: string;
	target: string;
	synthetic: boolean;
};

const colors = {
	healthy: { fill: "#dae4f0", stroke: "#2f64b2", text: "#1f497a" },
	failed: { fill: "#fee2e2", stroke: "#ef4444", text: "#7f1d1d" },
	pending: { fill: "#fef3c7", stroke: "#d97706", text: "#78350f" },
	root: { fill: "#c2410c", stroke: "#7c2d12", text: "#fef3c7" },
	cascading: { fill: "#fbbf24", stroke: "#b45309", text: "#78350f" },
};

const MAX_LABEL_CHARS = 14;

const wrapLabel = (label: string) => {
	if (label.length <= MAX_LABEL_CHARS) return [label];
	const parts = label.split("-");
	const lines: string[] = [];
	let current = "";

	for (const part of parts) {
		const next = current ? `${current}-${part}` : part;
		if (next.length <= MAX_LABEL_CHARS) {
			current = next;
			continue;
		}

		if (current) lines.push(current);
		if (part.length <= MAX_LABEL_CHARS) {
			current = part;
		} else {
			const chunks = part.match(new RegExp(`.{1,${MAX_LABEL_CHARS}}`, "g")) ?? [part];
			lines.push(...chunks.slice(0, -1));
			current = chunks[chunks.length - 1];
		}
	}

	if (current) lines.push(current);
	return lines.length ? lines : [label];
};

const nodeType = (name: string) => {
	const n = name.toLowerCase();
	if (["load-balancer", "ingress", "gateway", "proxy", "traefik", "nginx"].some((k) => n.includes(k))) return "gateway";
	if (["postgres", "mysql", "mongodb", "redis", "cache"].some((k) => n.includes(k))) return "storage";
	if (["kafka", "rabbit", "queue", "mq"].some((k) => n.includes(k))) return "network";
	if (["web", "frontend", "ui", "client"].some((k) => n.includes(k))) return "compute";
	if (["api", "app", "backend", "service", "worker", "server"].some((k) => n.includes(k))) return "compute";
	return "service";
};

const nodePriority = (pod: Pod) => {
	if (pod.failureType === "root-cause") return 0;
	if (pod.failureType === "cascading") return 1;
	if (pod.status === "failed") return 2;
	if (pod.status === "pending") return 3;
	return 4;
};

const tierOf = (pod: Pod) => {
	const n = pod.name.toLowerCase();
	if (["load-balancer", "ingress", "gateway", "proxy", "traefik", "nginx"].some((k) => n.includes(k))) return 0;
	if (["web", "frontend", "ui", "edge", "client"].some((k) => n.includes(k))) return 1;
	if (["api", "app", "backend", "service", "server", "worker"].some((k) => n.includes(k))) return 2;
	if (["db", "database", "postgres", "mysql", "mongo", "redis", "cache", "kafka", "rabbit", "queue"].some((k) => n.includes(k))) return 3;
	return 2;
};

export function DependencyGraphD3({ pods }: DependencyGraphD3Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [dimensions, setDimensions] = useState({ width: 1400, height: 900 });
	const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });

	useEffect(() => {
		const updateDimensions = () => {
			const width = containerRef.current?.clientWidth || 1400;
			setDimensions({ width, height: 800 });
		};

		updateDimensions();
		window.addEventListener("resize", updateDimensions);
		return () => window.removeEventListener("resize", updateDimensions);
	}, []);

	const graph = useMemo(() => {
		const width = dimensions.width;
		const height = dimensions.height;
		const nodeMap = new Map<string, NodeT>();

		for (const pod of pods) {
			const labelLines = wrapLabel(pod.name);
			const longest = Math.max(...labelLines.map((line) => line.length));
			const radius = Math.min(68, Math.max(42, longest * 3.5 + 18));
			nodeMap.set(pod.id, {
				id: pod.id,
				pod,
				x: 0,
				y: 0,
				radius,
				labelLines,
			});
		}

		const explicitLinks: LinkT[] = [];
		for (const pod of pods) {
			for (const depId of pod.dependsOn ?? []) {
				if (nodeMap.has(depId) && depId !== pod.id) {
					explicitLinks.push({ source: depId, target: pod.id, synthetic: false });
				}
			}
		}

		let links = [...explicitLinks];
		if (links.length === 0 && pods.length > 1) {
			const byTier = new Map<number, Pod[]>();
			for (const pod of pods) {
				const tier = tierOf(pod);
				if (!byTier.has(tier)) byTier.set(tier, []);
				byTier.get(tier)!.push(pod);
			}

			const tiers = [...byTier.keys()].sort((a, b) => a - b);
			for (let i = 0; i < tiers.length - 1; i += 1) {
				const current = [...(byTier.get(tiers[i]) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
				const next = [...(byTier.get(tiers[i + 1]) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
				if (!current.length || !next.length) continue;

				if (current.length === 1) {
					for (const target of next) links.push({ source: current[0].id, target: target.id, synthetic: true });
					continue;
				}

				if (next.length === 1) {
					for (const source of current) links.push({ source: source.id, target: next[0].id, synthetic: true });
					continue;
				}

				for (let j = 0; j < next.length; j += 1) {
					const sourceIdx = Math.floor((j * current.length) / next.length);
					links.push({ source: current[sourceIdx].id, target: next[j].id, synthetic: true });
				}
			}
		}

		const adjacency = new Map<string, Set<string>>();
		for (const node of nodeMap.values()) adjacency.set(node.id, new Set());
		for (const link of links) {
			adjacency.get(link.source)?.add(link.target);
			adjacency.get(link.target)?.add(link.source);
		}

		const seen = new Set<string>();
		const components: string[][] = [];
		for (const node of nodeMap.values()) {
			if (seen.has(node.id)) continue;
			const stack = [node.id];
			const component: string[] = [];
			seen.add(node.id);

			while (stack.length) {
				const current = stack.pop() as string;
				component.push(current);
				for (const next of adjacency.get(current) ?? []) {
					if (!seen.has(next)) {
						seen.add(next);
						stack.push(next);
					}
				}
			}

			components.push(component);
		}

		if (components.length > 1) {
			const anchors = components
				.map((component) =>
					component
						.map((id) => nodeMap.get(id))
						.filter((node): node is NodeT => Boolean(node))
						.sort((a, b) => nodePriority(a.pod) - nodePriority(b.pod) || a.pod.name.localeCompare(b.pod.name))[0],
				)
				.filter((node): node is NodeT => Boolean(node))
				.sort((a, b) => a.pod.name.localeCompare(b.pod.name));

			for (let i = 0; i < anchors.length - 1; i += 1) {
				links.push({ source: anchors[i].id, target: anchors[i + 1].id, synthetic: true });
			}
		}

		const incoming = new Map<string, string[]>();
		for (const node of nodeMap.values()) incoming.set(node.id, []);
		for (const link of links) incoming.get(link.target)?.push(link.source);

		const memo = new Map<string, number>();
		const active = new Set<string>();
		const levelOf = (id: string): number => {
			if (memo.has(id)) return memo.get(id)!;
			if (active.has(id)) return 0;

			active.add(id);
			const parents = incoming.get(id) ?? [];
			const level = parents.length ? 1 + Math.max(...parents.map((sourceId) => levelOf(sourceId))) : 0;
			active.delete(id);
			memo.set(id, level);
			return level;
		};

		for (const node of nodeMap.values()) levelOf(node.id);

		const maxLevel = Math.max(0, ...memo.values());
		const byLevel = new Map<number, NodeT[]>();
		for (const node of nodeMap.values()) {
			const level = memo.get(node.id) ?? 0;
			if (!byLevel.has(level)) byLevel.set(level, []);
			byLevel.get(level)!.push(node);
		}

		const positionedNodes = Array.from(nodeMap.values()).map((node) => ({ ...node }));
		const widthPadding = 140;
		const heightPadding = 110;

		for (let level = 0; level <= maxLevel; level += 1) {
			const levelNodes = [...(byLevel.get(level) ?? [])].sort(
				(a, b) => nodePriority(a.pod) - nodePriority(b.pod) || a.pod.name.localeCompare(b.pod.name),
			);
			if (!levelNodes.length) continue;

			const x = maxLevel === 0 ? width / 2 : widthPadding + ((width - widthPadding * 2) * level) / Math.max(1, maxLevel);
			const step = (height - heightPadding * 2) / Math.max(1, levelNodes.length + 1);

			levelNodes.forEach((node, index) => {
				const positioned = positionedNodes.find((candidate) => candidate.id === node.id);
				if (!positioned) return;
				positioned.x = x;
				positioned.y = levelNodes.length === 1 ? height / 2 : heightPadding + step * (index + 1);
			});
		}

		return { nodes: positionedNodes, links };
	}, [dimensions.height, dimensions.width, pods]);

	const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);

	const getEdgePoints = (link: LinkT) => {
		const source = nodeById.get(link.source);
		const target = nodeById.get(link.target);
		if (!source || !target) return null;

		const dx = target.x - source.x;
		const dy = target.y - source.y;
		const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
		const ux = dx / distance;
		const uy = dy / distance;

		return {
			x1: source.x + ux * source.radius,
			y1: source.y + uy * source.radius,
			x2: target.x - ux * target.radius,
			y2: target.y - uy * target.radius,
		};
	};

	const zoomBy = (factor: number) => {
		setTransform((prev) => ({ ...prev, scale: Math.min(2.5, Math.max(0.45, prev.scale * factor)) }));
	};

	const resetZoom = () => setTransform({ scale: 1, x: 0, y: 0 });

	const failedPods = pods.filter((pod) => pod.status === "failed");
	const pendingPods = pods.filter((pod) => pod.status === "pending");
	const healthyPods = pods.filter((pod) => pod.status === "running");
	const hasIssues = failedPods.length + pendingPods.length > 0;
	const labelLineHeight = 16;

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

				<div className="flex flex-wrap gap-2 text-xs">
					<div className="rounded-full border border-orange-300 bg-orange-100 px-3 py-1.5 font-semibold text-orange-800">Root Cause</div>
					<div className="rounded-full border border-red-300 bg-red-100 px-3 py-1.5 font-semibold text-red-800">Failed Node</div>
					<div className="rounded-full border border-amber-300 bg-amber-100 px-3 py-1.5 font-semibold text-amber-800">Cascading</div>
					<div className="rounded-full border border-blue-300 bg-blue-100 px-3 py-1.5 font-semibold text-blue-800">Static Layout</div>
					<div className="rounded-full border border-slate-300 bg-slate-100 px-3 py-1.5 font-semibold text-slate-700">Connected Links</div>
				</div>
			</div>

			<div className="relative mb-4 flex gap-2">
				<button onClick={() => zoomBy(1.25)} className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50">
					<ZoomIn className="h-4 w-4" /> Zoom In
				</button>
				<button onClick={() => zoomBy(0.8)} className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50">
					<ZoomOut className="h-4 w-4" /> Zoom Out
				</button>
				<button onClick={resetZoom} className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50">
					<Home className="h-4 w-4" /> Reset View
				</button>
			</div>

			<div ref={containerRef} className="relative overflow-hidden rounded-xl border border-[#d7dbe1] bg-white" style={{ height: "800px" }}>
				<svg className="h-full w-full" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} style={{ background: "#fafbfc" }}>
					<defs>
						<marker id="arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
							<polygon points="0 0, 10 3, 0 6" fill="#6b7280" />
						</marker>
						<pattern id="bgGrid" width="28" height="28" patternUnits="userSpaceOnUse">
							<path d="M 28 0 L 0 0 0 28" fill="none" stroke="#d9dde3" strokeWidth="1" />
						</pattern>
					</defs>

					<rect x="0" y="0" width={dimensions.width} height={dimensions.height} fill="url(#bgGrid)" />

					<g transform={`translate(${transform.x},${transform.y}) scale(${transform.scale})`}>
						{graph.links.map((link, idx) => {
							const points = getEdgePoints(link);
							if (!points) return null;

							return (
								<line
									key={`${link.source}-${link.target}-${idx}`}
									x1={points.x1}
									y1={points.y1}
									x2={points.x2}
									y2={points.y2}
									stroke={link.synthetic ? "#c4c9d1" : "#b0b0b0"}
									strokeWidth={link.synthetic ? 1.8 : 2.2}
									strokeLinecap="round"
									strokeDasharray={link.synthetic ? "7 6" : undefined}
									markerEnd="url(#arrowhead)"
									opacity={link.synthetic ? 0.85 : 1}
								/>
							);
						})}

						{graph.nodes.map((node) => {
							const type = nodeType(node.pod.name);
							const isRoot = node.pod.failureType === "root-cause";
							const isCascading = node.pod.failureType === "cascading";
							const isFailed = node.pod.status === "failed";
							const isPending = node.pod.status === "pending";

							const fill = isRoot
								? colors.root.fill
								: isCascading
									? colors.cascading.fill
									: isFailed
										? colors.failed.fill
										: isPending
											? colors.pending.fill
											: colors.healthy.fill;

							const stroke = isRoot
								? colors.root.stroke
								: isCascading
									? colors.cascading.stroke
									: isFailed
										? colors.failed.stroke
										: isPending
											? colors.pending.stroke
											: colors.healthy.stroke;

							const textFill = isRoot
								? colors.root.text
								: isCascading
									? colors.cascading.text
									: isFailed
										? colors.failed.text
										: isPending
											? colors.pending.text
											: colors.healthy.text;

							return (
								<g key={node.id} transform={`translate(${node.x},${node.y})`}>
									<circle r={node.radius} fill={fill} stroke={stroke} strokeWidth={isRoot ? 4 : 2.5} />

									<text textAnchor="middle" dominantBaseline="middle" fontSize="13px" fontWeight="600" fill={textFill} pointerEvents="none" style={{ userSelect: "none" }}>
										{node.labelLines.map((line, index) => {
											const startDy = -((node.labelLines.length - 1) * labelLineHeight) / 2;
											return (
												<tspan key={`${node.id}-${index}`} x={0} dy={index === 0 ? startDy : labelLineHeight}>
													{line}
												</tspan>
											);
										})}
									</text>

									<text textAnchor="middle" dominantBaseline="middle" fontSize="11px" fontWeight="700" fill={isFailed ? "#dc2626" : isPending ? "#ea580c" : "#16a34a"} dy={node.radius + 20} pointerEvents="none" style={{ userSelect: "none" }}>
										{isRoot ? "ROOT CAUSE" : isCascading ? "CASCADING" : node.pod.status.toUpperCase()}
									</text>
								</g>
							);
						})}
					</g>
				</svg>
			</div>

			<div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-4">
				<div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">Healthy: <span className="font-semibold">{healthyPods.length}</span></div>
				<div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">Pending: <span className="font-semibold">{pendingPods.length}</span></div>
				<div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">Failed: <span className="font-semibold">{failedPods.length}</span></div>
				<div className="rounded-lg border border-orange-300 bg-orange-50 px-3 py-2 text-xs text-orange-800">Nodes: <span className="font-semibold">{pods.length}</span></div>
			</div>

			<div className="mt-4 rounded-lg border border-slate-300 bg-slate-100 p-3 text-xs text-slate-700">
				Connected dependency layout with deterministic tiers and fallback links for disconnected data.
			</div>
		</div>
	);
}
