"use client";

import React, { useState } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { useMetricsContext } from "@/lib/metricsContext";

export function MetricsUrlInput() {
  const { metricsUrl, setMetricsUrl, connectionStatus } = useMetricsContext();
  const [input, setInput] = useState(metricsUrl);
  const [showInput, setShowInput] = useState(false);

  const handleSave = () => {
    if (input.trim()) {
      setMetricsUrl(input);
      setShowInput(false);
    }
  };

  const handleClear = () => {
    setMetricsUrl("");
    setInput("");
  };

  return (
    <div className="fixed top-4 right-4 z-40">
      {!showInput ? (
        <button
          onClick={() => setShowInput(true)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
            metricsUrl
              ? "bg-green-500 hover:bg-green-600 text-white"
              : "bg-blue-500 hover:bg-blue-600 text-white"
          }`}
        >
          {metricsUrl ? (
            <>
              <CheckCircle2 className="w-4 h-4" />
              Metrics Connected
            </>
          ) : (
            <>
              <AlertCircle className="w-4 h-4" />
              Add Metrics URL
            </>
          )}
        </button>
      ) : (
        <div className="bg-white rounded-lg shadow-lg p-4 w-96">
          <h3 className="text-sm font-semibold mb-3 text-gray-900">
            Metrics ngrok URL
          </h3>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="https://your-ngrok-url.ngrok-free.app/api/metrics"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {metricsUrl && (
            <div className="text-xs text-gray-500 mb-3 p-2 bg-gray-50 rounded">
              Current: {metricsUrl}
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              className="flex-1 px-3 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600"
            >
              Save
            </button>
            {metricsUrl && (
              <button
                onClick={handleClear}
                className="px-3 py-2 bg-red-500 text-white rounded-md text-sm font-medium hover:bg-red-600"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => setShowInput(false)}
              className="px-3 py-2 bg-gray-200 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-300"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {connectionStatus === "connected" && (
            <div className="text-xs text-green-600 mt-3 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" />
              Connected & fetching metrics
            </div>
          )}
          {connectionStatus === "error" && (
            <div className="text-xs text-red-600 mt-3 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              Failed to connect to metrics URL
            </div>
          )}
        </div>
      )}
    </div>
  );
}
