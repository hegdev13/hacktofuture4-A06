"use client";

import React, { useState, useCallback } from "react";
import { useConversation } from "@elevenlabs/react";
import { Mic, MicOff, Phone, PhoneOff } from "lucide-react";

const AGENT_ID = "agent_7901kp0j3ecqfxy8wmj8dwskkejr";

interface Message {
  type: "user" | "agent";
  content: string;
  timestamp: Date;
}

export const ElevenLabsAgent: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const conversation = useConversation({
    onConnect: () => {
      console.log("✓ Connected to agent");
    },
    onDisconnect: () => {
      console.log("✓ Disconnected from agent");
    },
    onMessage: (message) => {
      console.log("Message received:", message);
      
      // Handle different message types
      if (message.type === "user_transcript") {
        setMessages((prev) => [
          ...prev,
          {
            type: "user",
            content: message.user_transcript,
            timestamp: new Date(),
          },
        ]);
      } else if (message.type === "agent_response") {
        setMessages((prev) => [
          ...prev,
          {
            type: "agent",
            content: message.agent_response,
            timestamp: new Date(),
          },
        ]);
      }
    },
    onError: (error) => {
      console.error("Agent error:", error);
    },
    onModeChange: (mode) => {
      console.log("Mode changed:", mode);
    },
  });

  const startConversation = useCallback(async () => {
    try {
      setIsLoading(true);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      await conversation.startSession({
        agentId: AGENT_ID,
        connectionType: "webrtc",
      });

      // Stop the stream after starting the session
      stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      console.error("Failed to start conversation:", error);
      alert("Failed to start conversation. Please check microphone permissions.");
    } finally {
      setIsLoading(false);
    }
  }, [conversation]);

  const endConversation = useCallback(async () => {
    try {
      await conversation.endSession();
      setMessages([]);
    } catch (error) {
      console.error("Failed to end conversation:", error);
    }
  }, [conversation]);

  const isConnected = conversation.status === "connected";

  return (
    <div className="flex flex-col h-full w-full max-w-2xl mx-auto">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-500 to-purple-600 text-white p-6 rounded-t-lg">
        <h1 className="text-2xl font-bold mb-2">Kubernetes AI Agent</h1>
        <p className="text-blue-100">
          {isConnected ? "Connected" : "Not connected"} • Powered by ElevenLabs
        </p>
      </div>

      {/* Messages Container */}
      <div className="flex-1 overflow-y-auto bg-gray-50 p-6 space-y-4">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            <div className="text-center">
              <Mic className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Start a conversation to begin</p>
            </div>
          </div>
        ) : (
          messages.map((msg, idx) => (
            <div
              key={idx}
              className={`flex ${
                msg.type === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className={`max-w-xs lg:max-w-md rounded-lg px-4 py-2 ${
                  msg.type === "user"
                    ? "bg-blue-500 text-white"
                    : "bg-gray-200 text-gray-900"
                }`}
              >
                <p className="text-sm">{msg.content}</p>
                <p className="text-xs mt-1 opacity-70">
                  {msg.timestamp.toLocaleTimeString()}
                </p>
              </div>
            </div>
          ))
        )}
        {isConnected && (
          <div className="flex justify-center pt-4">
            <div className="inline-flex items-center gap-2 text-green-600">
              <div className="w-2 h-2 bg-green-600 rounded-full animate-pulse" />
              <span className="text-sm">
                {conversation.isSpeaking ? "Agent speaking..." : "Listening..."}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="bg-white border-t border-gray-200 p-6 rounded-b-lg flex gap-4">
        {!isConnected ? (
          <button
            onClick={startConversation}
            disabled={isLoading}
            className="flex-1 flex items-center justify-center gap-2 bg-green-500 hover:bg-green-600 disabled:bg-gray-400 text-white font-semibold py-3 rounded-lg transition"
          >
            <Phone className="w-5 h-5" />
            {isLoading ? "Connecting..." : "Start Conversation"}
          </button>
        ) : (
          <>
            <button
              onClick={endConversation}
              className="flex-1 flex items-center justify-center gap-2 bg-red-500 hover:bg-red-600 text-white font-semibold py-3 rounded-lg transition"
            >
              <PhoneOff className="w-5 h-5" />
              End Call
            </button>
            <button
              className="flex items-center justify-center gap-2 bg-gray-200 text-gray-700 font-semibold py-3 px-6 rounded-lg"
              disabled
            >
              {conversation.isSpeaking ? (
                <>
                  <MicOff className="w-5 h-5" />
                  Muted
                </>
              ) : (
                <>
                  <Mic className="w-5 h-5" />
                  Active
                </>
              )}
            </button>
          </>
        )}
      </div>

      {/* Status Info */}
      <div className="bg-gray-100 border-t border-gray-200 px-6 py-3 rounded-b-lg text-sm text-gray-600">
        <p>
          Status: <span className="font-semibold">{conversation.status}</span>
        </p>
        {isConnected && (
          <p className="mt-1">
            Volume In: {Math.round((conversation.getInputVolume?.() || 0) * 100)}% | Volume Out:{" "}
            {Math.round((conversation.getOutputVolume?.() || 0) * 100)}%
          </p>
        )}
      </div>
    </div>
  );
};

export default ElevenLabsAgent;
