"use client";

import React from "react";
import { AlertCircle, CheckCircle, Zap, TrendingDown, Link2 } from "lucide-react";

interface Pod {
  id: string;
  name: string;
  status: "running" | "failed" | "pending";
  message?: string;
  dependsOn?: string[];
}

interface DependencyGraphProps {
  pods: Pod[];
  title?: string;
  showOnlyErrors?: boolean;
}

export function DependencyGraph({
  pods,
  title = "Pod Dependency Analysis",
  showOnlyErrors = true,
}: DependencyGraphProps) {
  // Filter pods if showing only errors
  const displayPods = showOnlyErrors
    ? pods.filter((p) => p.status === "failed" || p.status === "pending")
    : pods;

  if (displayPods.length === 0 && showOnlyErrors) {
    return null;
  }

  // Find root cause pods
  const failedPodIds = new Set(pods.filter((p) => p.status === "failed").map((p) => p.id));
  const rootCausePods = new Set<string>();

  pods.forEach((pod) => {
    if (failedPodIds.has(pod.id) && pod.dependsOn) {
      pod.dependsOn.forEach((depId) => {
        const depPod = pods.find((p) => p.id === depId);
        if (depPod?.status === "failed") {
          rootCausePods.add(depId);
        }
      });
    }
  });

  const getStatusColor = (status: string, isRootCause: boolean = false) => {
    if (isRootCause) {
      return "bg-gradient-to-br from-red-950 to-red-900 border-2 border-red-600 shadow-lg shadow-red-900/50";
    }
    switch (status) {
      case "running":
        return "bg-gradient-to-br from-emerald-950 to-emerald-900 border border-emerald-700/50";
      case "failed":
        return "bg-gradient-to-br from-rose-950 to-rose-900 border-2 border-rose-700 shadow-md shadow-rose-900/30";
      case "pending":
        return "bg-gradient-to-br from-amber-950 to-amber-900 border border-amber-700/50";
      default:
        return "bg-gradient-to-br from-gray-900 to-gray-800 border border-gray-700/50";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "running":
        return <CheckCircle className="w-5 h-5 text-emerald-400" />;
      case "failed":
        return <AlertCircle className="w-5 h-5 text-rose-400 animate-pulse" />;
      case "pending":
        return <Zap className="w-5 h-5 text-amber-400" />;
      default:
        return null;
    }
  };

  const failedCount = failedPodIds.size;
  const rootCauseCount = rootCausePods.size;

  return (
    <div className="w-full bg-gradient-to-b from-slate-950 to-slate-900 border border-slate-800/50 rounded-xl p-6 space-y-6 shadow-2xl">
      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-br from-blue-900 to-blue-800 rounded-lg">
              <Link2 className="w-5 h-5 text-blue-300" />
            </div>
            <h3 className="text-xl font-bold text-white">{title}</h3>
          </div>
          {failedCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-1 bg-red-900/30 border border-red-700/50 rounded-full">
              <AlertCircle className="w-4 h-4 text-red-400" />
              <span className="text-sm font-semibold text-red-300">{failedCount} Issues</span>
            </div>
          )}
        </div>
        
        {failedCount > 0 && (
          <p className="text-sm text-gray-300">
            {rootCauseCount > 0 ? (
              <>
                <span className="text-red-300 font-semibold">{rootCauseCount} root cause</span>
                {rootCauseCount === 1 ? " issue" : " issues"} detected • 
                <span className="text-orange-300 font-semibold ml-1">{failedCount} pod{failedCount === 1 ? "" : "s"} affected</span>
              </>
            ) : (
              <>
                <span className="text-orange-300 font-semibold">{failedCount} pod{failedCount === 1 ? "" : "s"}</span> experiencing issues
              </>
            )}
          </p>
        )}
      </div>

      {/* Status Indicators */}
      {failedCount > 0 && (
        <div className="grid grid-cols-3 gap-3 p-3 bg-slate-900/50 rounded-lg border border-slate-800/50">
          <div className="text-center">
            <div className="text-2xl font-bold text-red-400">{rootCauseCount}</div>
            <div className="text-xs text-gray-400 mt-1">Root Causes</div>
          </div>
          <div className="text-center border-l border-r border-slate-700/50">
            <div className="text-2xl font-bold text-rose-400">{failedCount - rootCauseCount}</div>
            <div className="text-xs text-gray-400 mt-1">Cascading</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-emerald-400">{pods.filter(p => p.status === "running").length}</div>
            <div className="text-xs text-gray-400 mt-1">Healthy</div>
          </div>
        </div>
      )}

      {/* Failed Pods Section */}
      {failedCount > 0 && (
        <div className="space-y-4 border-t border-slate-800/50 pt-6">
          <div className="flex items-center gap-2">
            <div className="w-1 h-6 bg-gradient-to-b from-red-500 to-red-600 rounded-full"></div>
            <h4 className="text-sm font-bold text-red-300 uppercase tracking-wider">Failed Components</h4>
          </div>
          
          <div className="space-y-3">
            {pods
              .filter((p) => failedPodIds.has(p.id))
              .map((pod) => {
                const isRootCause = rootCausePods.has(pod.id);
                return (
                  <div
                    key={pod.id}
                    className={`p-4 rounded-lg transition-all duration-300 hover:shadow-lg ${getStatusColor(
                      pod.status,
                      isRootCause
                    )}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className="mt-0.5">{getStatusIcon(pod.status)}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-semibold text-white text-sm">{pod.name}</p>
                            {isRootCause && (
                              <span className="text-xs font-bold bg-red-600 text-white px-2 py-0.5 rounded-full">
                                ROOT CAUSE
                              </span>
                            )}
                          </div>
                          {pod.message && (
                            <p className="text-xs text-gray-300 mt-1.5 opacity-90">{pod.message}</p>
                          )}
                        </div>
                      </div>
                      <TrendingDown className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                    </div>

                    {/* Dependencies */}
                    {pod.dependsOn && pod.dependsOn.length > 0 && (
                      <div className="mt-4 ml-8 space-y-2">
                        <p className="text-xs text-gray-400 font-medium">Depends on:</p>
                        <div className="space-y-1.5">
                          {pod.dependsOn.map((depId) => {
                            const depPod = pods.find((p) => p.id === depId);
                            if (!depPod) return null;

                            const depIsRootCause = rootCausePods.has(depId);
                            return (
                              <div
                                key={depId}
                                className={`text-xs p-2.5 rounded-md flex items-center gap-2 transition-all ${
                                  depIsRootCause
                                    ? "bg-red-900/60 border border-red-700/80 text-red-200"
                                    : depPod.status === "running"
                                    ? "bg-slate-800/60 border border-slate-700/50 text-gray-300"
                                    : "bg-rose-900/40 border border-rose-700/50 text-rose-200"
                                }`}
                              >
                                {getStatusIcon(depPod.status)}
                                <span className="flex-1">{depPod.name}</span>
                                <span className={`text-xs font-semibold ${
                                  depPod.status === "running" ? "text-emerald-400" : "text-rose-400"
                                }`}>
                                  {depPod.status === "running" ? "✓" : "✗"}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {failedCount > 0 && (
        <div className="bg-gradient-to-r from-blue-900/20 to-cyan-900/20 border border-blue-700/30 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-1 h-5 bg-gradient-to-b from-blue-400 to-cyan-400 rounded-full"></div>
            <p className="text-sm font-bold text-blue-300 uppercase tracking-wider">Action Plan</p>
          </div>
          <ul className="text-sm text-blue-200/90 space-y-2">
            {rootCauseCount > 0 ? (
              <>
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 font-bold mt-0.5">1.</span>
                  <span>
                    <strong>Fix root cause:</strong> {Array.from(rootCausePods)[0]} is preventing dependent services
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 font-bold mt-0.5">2.</span>
                  <span>Check logs and restart the affected pod</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 font-bold mt-0.5">3.</span>
                  <span>Dependent services will auto-recover once root cause is healthy</span>
                </li>
              </>
            ) : (
              <>
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 font-bold mt-0.5">•</span>
                  <span>Check resource quotas and limits</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 font-bold mt-0.5">•</span>
                  <span>Review pod logs for errors</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 font-bold mt-0.5">•</span>
                  <span>Consider pod restart if stuck in pending</span>
                </li>
              </>
            )}
          </ul>
        </div>
      )}

      {/* All Healthy Message */}
      {failedCount === 0 && (
        <div className="flex items-center justify-center py-6">
          <div className="text-center space-y-2">
            <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto" />
            <p className="text-emerald-300 font-semibold">All systems operating normally</p>
            <p className="text-gray-400 text-sm">{pods.length} pods running healthy</p>
          </div>
        </div>
      )}
    </div>
  );
}
