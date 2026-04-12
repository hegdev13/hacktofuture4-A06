"use client";

import React, { useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import {
  Phone,
  PhoneOff,
  MessageCircle,
  X,
  Volume2,
  VolumeX,
  Loader,
} from "lucide-react";
import { useMetricsContext } from "@/lib/metricsContext";

const AGENT_ID = "agent_7901kp0j3ecqfxy8wmj8dwskkejr";

interface AgentWidgetProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

function AgentWidgetContent({ isOpen, setIsOpen }: AgentWidgetProps) {
  const { metrics, metricsUrl } = useMetricsContext();
  const conversation = useConversation({
    onConnect: () => console.log("Agent connected"),
    onDisconnect: () => console.log("Agent disconnected"),
    onMessage: (message) => console.log("Message:", message),
    onError: (error) => console.error("Agent error:", error),
  });

  const startConversation = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Create context from metrics
      const contextMessage = metricsUrl
        ? `You are analyzing Kubernetes metrics from: ${metricsUrl}. Current metrics: ${JSON.stringify(
            metrics,
            null,
            2
          )}. Help the user understand and manage their cluster based on this data.`
        : "You are a Kubernetes AI assistant. Help the user with their cluster management questions.";

      await conversation.startSession({
        agentId: AGENT_ID,
        connectionType: "webrtc",
        overrides: {
          prompt: contextMessage,
          firstMessage: metricsUrl
            ? `I have access to your cluster metrics. I can see you${
                metrics
                  ? ` have ${Object.keys(metrics).length} data points`
                  : " connected your metrics"
              }. What would you like to know about your cluster?`
            : "Hi! I'm your Kubernetes AI assistant. How can I help?",
        },
      });

      stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      console.error("Failed to start conversation:", error);
      alert("Microphone access required");
    }
  };

  const isConnected = conversation.status === "connected";

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-lg hover:shadow-xl hover:scale-110 transition-all"
        title="Open AI Assistant"
      >
        <MessageCircle className="w-6 h-6" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 w-96 bg-white rounded-lg shadow-2xl overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-500 to-purple-600 text-white p-4 flex justify-between items-center">
        <div>
          <h3 className="font-semibold">Kubernetes Assistant</h3>
          <p className="text-sm text-blue-100">
            {isConnected ? "Connected" : "Click to start"} •{" "}
            {metricsUrl ? "Metrics Aware" : "No Metrics"}
          </p>
        </div>
        <button
          onClick={() => {
            if (isConnected) conversation.endSession();
            setIsOpen(false);
          }}
          className="p-1 hover:bg-white hover:bg-opacity-20 rounded"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Content */}
      <div className="p-4 space-y-4">
        {metricsUrl && metrics && (
          <div className="bg-blue-50 p-3 rounded-lg text-sm">
            <p className="font-semibold text-gray-900 mb-2">📊 Metrics Loaded</p>
            <div className="text-xs text-gray-700 max-h-24 overflow-y-auto">
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(metrics, null, 2).slice(0, 200)}...
              </pre>
            </div>
          </div>
        )}

        {!metricsUrl && (
          <div className="bg-amber-50 p-3 rounded-lg text-sm text-amber-800">
            ℹ️ Add metrics URL at the top right to enable context-aware responses
          </div>
        )}

        {/* Status */}
        <div className="text-center">
          <p className="text-sm font-medium text-gray-700">
            {isConnected ? (
              <span className="flex items-center justify-center gap-2 text-green-600">
                <span className="w-2 h-2 bg-green-600 rounded-full animate-pulse" />
                {conversation.isSpeaking ? "Listening..." : "Agent Speaking..."}
              </span>
            ) : (
              "Ready to talk"
            )}
          </p>
        </div>

        {/* Controls */}
        <div className="flex gap-2">
          {!isConnected ? (
            <button
              onClick={startConversation}
              className="flex-1 flex items-center justify-center gap-2 bg-green-500 hover:bg-green-600 text-white font-semibold py-2 rounded-lg transition"
            >
              <Phone className="w-4 h-4" />
              Start Talk
            </button>
          ) : (
            <>
              <button
                onClick={() => conversation.endSession()}
                className="flex-1 flex items-center justify-center gap-2 bg-red-500 hover:bg-red-600 text-white font-semibold py-2 rounded-lg transition"
              >
                <PhoneOff className="w-4 h-4" />
                End
              </button>
              <button
                className="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg flex items-center justify-center"
                disabled
              >
                {conversation.isSpeaking ? (
                  <Volume2 className="w-4 h-4" />
                ) : (
                  <VolumeX className="w-4 h-4" />
                )}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="bg-gray-50 px-4 py-3 border-t border-gray-200 text-xs text-gray-600">
        <p>Status: <span className="font-semibold">{conversation.status}</span></p>
      </div>
    </div>
  );
}

export function AgentWidget() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <ConversationProvider>
      <AgentWidgetContent isOpen={isOpen} setIsOpen={setIsOpen} />
    </ConversationProvider>
  );
}
