"use client";

import React from "react";
import { AlertCircle, CheckCircle, Zap, ChevronDown, ChevronRight } from "lucide-react";

interface Pod {
  id: string;
  name: string;
  status: "running" | "failed" | "pending";
  failureType?: "healthy" | "root-cause" | "cascading";
  message?: string;
  dependsOn?: string[];
}

interface DependencyTreeProps {
  pods: Pod[];
}

export function DependencyTree({ pods }: DependencyTreeProps) {
  const [expandedPods, setExpandedPods] = React.useState<Set<string>>(
    new Set(pods.filter(p => p.status !== "running").map(p => p.id))
  );

  // Find root pods (pods with no dependents)
  const dependentMap = new Map<string, string[]>();
  pods.forEach((pod) => {
    if (pod.dependsOn) {
      pod.dependsOn.forEach((depId) => {
        if (!dependentMap.has(depId)) {
          dependentMap.set(depId, []);
        }
        dependentMap.get(depId)!.push(pod.id);
      });
    }
  });

  // Find root pods (those that no one depends on, or are top-level)
  const rootPods = pods.filter((p) => !pods.some((other) => other.dependsOn?.includes(p.id)));

  const toggleExpand = (podId: string) => {
    const newExpanded = new Set(expandedPods);
    if (newExpanded.has(podId)) {
      newExpanded.delete(podId);
    } else {
      newExpanded.add(podId);
    }
    setExpandedPods(newExpanded);
  };

  const getStatusIcon = (status: string, failureType?: Pod["failureType"]) => {
    if (failureType === "root-cause") {
      return <AlertCircle className="w-4 h-4 text-rose-400" />;
    }
    if (failureType === "cascading") {
      return <Zap className="w-4 h-4 text-amber-400" />;
    }
    switch (status) {
      case "running":
        return <CheckCircle className="w-4 h-4 text-emerald-400" />;
      case "failed":
        return <AlertCircle className="w-4 h-4 text-rose-400 animate-pulse" />;
      case "pending":
        return <Zap className="w-4 h-4 text-amber-400" />;
      default:
        return null;
    }
  };

  const getStatusBgColor = (status: string, failureType?: Pod["failureType"], isRootCause: boolean = false) => {
    if (isRootCause || failureType === "root-cause") {
      return "bg-red-900/40 border border-red-700/60 hover:bg-red-900/60";
    }
    if (failureType === "cascading") {
      return "bg-amber-900/25 border border-amber-700/60 hover:bg-amber-900/35";
    }
    switch (status) {
      case "running":
        return "bg-emerald-900/20 border border-emerald-700/40 hover:bg-emerald-900/30";
      case "failed":
        return "bg-rose-900/30 border border-rose-700/60 hover:bg-rose-900/50";
      case "pending":
        return "bg-amber-900/20 border border-amber-700/40 hover:bg-amber-900/30";
      default:
        return "bg-slate-900/20 border border-slate-700/40 hover:bg-slate-900/30";
    }
  };

  const getTextColor = (status: string, failureType?: Pod["failureType"], isRootCause: boolean = false) => {
    if (isRootCause || failureType === "root-cause") {
      return "text-red-300";
    }
    if (failureType === "cascading") {
      return "text-amber-300";
    }
    switch (status) {
      case "running":
        return "text-emerald-300";
      case "failed":
        return "text-rose-300";
      case "pending":
        return "text-amber-300";
      default:
        return "text-gray-300";
    }
  };

  const findRootCausePods = () => {
    const flaggedRoots = pods.filter((p) => p.failureType === "root-cause").map((p) => p.id);
    if (flaggedRoots.length) {
      return new Set(flaggedRoots);
    }

    const failedPods = pods.filter((p) => p.status === "failed");
    const rootCauses = new Set<string>();

    failedPods.forEach((pod) => {
      if (pod.dependsOn) {
        pod.dependsOn.forEach((depId) => {
          const depPod = pods.find((p) => p.id === depId);
          if (depPod?.status === "failed") {
            rootCauses.add(depId);
          }
        });
      }
    });

    return rootCauses;
  };

  const rootCausePods = findRootCausePods();
  const hasIssues = pods.some(p => p.status !== "running");

  const renderPodNode = (pod: Pod, level: number = 0) => {
    const isDependencyNode = dependentMap.get(pod.id);
    const isExpanded = expandedPods.has(pod.id);
    const isRootCause = rootCausePods.has(pod.id);

    return (
      <div key={pod.id}>
        <div
          className={`
            flex items-center gap-2 px-3 py-2 rounded-lg border transition-all cursor-pointer
            ${getStatusBgColor(pod.status, pod.failureType, isRootCause)}
          `}
          style={{ marginLeft: `${level * 24}px` }}
          onClick={() => isDependencyNode && toggleExpand(pod.id)}
        >
          {/* Toggle arrow */}
          <div className="w-4 flex items-center justify-center">
            {isDependencyNode && isDependencyNode.length > 0 ? (
              isExpanded ? (
                <ChevronDown className="w-4 h-4 text-gray-400" />
              ) : (
                <ChevronRight className="w-4 h-4 text-gray-400" />
              )
            ) : (
              <div className="w-1 h-1 bg-gray-600 rounded-full"></div>
            )}
          </div>

          {/* Status icon */}
          <div className="flex-shrink-0">{getStatusIcon(pod.status, pod.failureType)}</div>

          {/* Pod name and info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`font-medium text-sm ${getTextColor(pod.status, pod.failureType, isRootCause)}`}>
                {pod.name}
              </span>
              {isRootCause && (
                <span className="text-xs font-bold bg-red-600 text-white px-2 py-0.5 rounded-full">
                  ROOT CAUSE
                </span>
              )}
              {pod.failureType === "cascading" ? (
                <span className="text-xs font-medium text-amber-400">Cascading</span>
              ) : pod.status === "failed" ? (
                <span className="text-xs font-medium text-rose-400">Failed</span>
              ) : pod.status === "pending" ? (
                <span className="text-xs font-medium text-amber-400">Pending</span>
              ) : null}
            </div>
            {pod.message && (
              <p className="text-xs text-gray-400 mt-0.5 truncate">{pod.message}</p>
            )}
          </div>

          {/* Dependent count */}
          {isDependencyNode && isDependencyNode.length > 0 && (
            <div className="text-xs text-gray-400 ml-2 px-2 py-1 bg-slate-950/50 rounded">
              {isDependencyNode.length}
            </div>
          )}
        </div>

        {/* Render dependencies if expanded */}
        {isExpanded && isDependencyNode && isDependencyNode.length > 0 && (
          <div className="border-l-2 border-slate-700/30 ml-6 pl-0">
            {isDependencyNode.map((depId) => {
              const depPod = pods.find((p) => p.id === depId);
              return depPod ? renderPodNode(depPod, level + 1) : null;
            })}
          </div>
        )}
      </div>
    );
  };

  if (!hasIssues) {
    return (
      <div className="w-full bg-gradient-to-b from-slate-950 to-slate-900 border border-slate-800/50 rounded-xl p-6 shadow-2xl">
        <div className="flex items-center justify-center py-8">
          <div className="text-center space-y-3">
            <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto" />
            <p className="text-emerald-300 font-semibold">All Systems Healthy</p>
            <p className="text-gray-400 text-sm">{pods.length} pods running normally</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full bg-gradient-to-b from-slate-950 to-slate-900 border border-slate-800/50 rounded-xl p-6 space-y-4 shadow-2xl">
      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-br from-blue-900 to-blue-800 rounded-lg">
              <svg className="w-5 h-5 text-blue-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-white">Dependency Tree</h3>
          </div>
          <div className="flex items-center gap-2 px-3 py-1 bg-red-900/30 border border-red-700/50 rounded-full">
            <AlertCircle className="w-4 h-4 text-red-400" />
            <span className="text-sm font-semibold text-red-300">Issues Detected</span>
          </div>
        </div>

        <p className="text-sm text-gray-300">
          <span className="text-red-300 font-semibold">{pods.filter(p => p.status === "failed").length} failed</span>,{" "}
          <span className="text-amber-300 font-semibold">{pods.filter(p => p.status === "pending").length} pending</span>,{" "}
          <span className="text-emerald-300 font-semibold">{pods.filter(p => p.status === "running").length} healthy</span>
        </p>
      </div>

      {/* Tree view */}
      <div className="space-y-2">
        <p className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Pod Hierarchy</p>
        <div className="space-y-1 bg-slate-950/50 rounded-lg p-4 border border-slate-800/30 max-h-96 overflow-y-auto">
          {rootPods.map((pod) => renderPodNode(pod))}
        </div>
      </div>

      {/* Legend */}
      <div className="grid grid-cols-3 gap-3 p-3 bg-slate-900/50 rounded-lg border border-slate-800/50 text-xs">
        <div className="flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-emerald-400" />
          <span className="text-gray-400">Running</span>
        </div>
        <div className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-400" />
          <span className="text-gray-400">Failed</span>
        </div>
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-amber-400" />
          <span className="text-gray-400">Pending</span>
        </div>
      </div>

      {/* Quick tip */}
      <div className="bg-blue-900/20 border border-blue-700/30 rounded-lg p-3">
        <p className="text-xs text-blue-300">
          💡 <strong>Click pods to expand/collapse dependencies</strong> — Click nodes with numbers to see their dependents
        </p>
      </div>
    </div>
  );
}
