/**
 * Advanced ElevenLabs Agent Integration Examples
 * Custom tools, overrides, and advanced patterns
 */

import { useConversation } from "@elevenlabs/react";
import { useState } from "react";

/**
 * Example 1: Agent with Client Tools
 * Allows agent to invoke custom client-side functions
 */
export function AgentWithClientTools() {
  const [toolOutput, setToolOutput] = useState<string>("");

  // Define custom tools the agent can call
  const clientTools = {
    get_cluster_status: async () => {
      const response = await fetch("/api/cluster/status");
      const data = await response.json();
      setToolOutput(JSON.stringify(data));
      return JSON.stringify(data);
    },

    get_pod_logs: async (podName: string) => {
      const response = await fetch(`/api/pods/${podName}/logs`);
      const logs = await response.json();
      setToolOutput(logs.content);
      return logs.content;
    },

    restart_pod: async (podName: string) => {
      const response = await fetch(`/api/pods/${podName}/restart`, {
        method: "POST",
      });
      const result = await response.json();
      setToolOutput(result.message);
      return result.message;
    },

    get_metrics: async (type: string) => {
      const response = await fetch(`/api/metrics?type=${type}`);
      const metrics = await response.json();
      setToolOutput(JSON.stringify(metrics));
      return JSON.stringify(metrics);
    },
  };

  const conversation = useConversation({
    onConnect: () => console.log("Connected with tools"),
    onMessage: (message) => console.log("Message:", message),
    onError: (error) => console.error("Error:", error),
  });

  const start = async () => {
    await conversation.startSession({
      agentId: "agent_7901kp0j3ecqfxy8wmj8dwskkejr",
      connectionType: "webrtc",
      clientTools, // Pass custom tools to agent
    });
  };

  return (
    <div>
      <button onClick={start}>Start with Tools</button>
      {toolOutput && <pre>{toolOutput}</pre>}
    </div>
  );
}

/**
 * Example 2: Agent with Custom Overrides
 * Customize agent behavior per session
 */
export function AgentWithOverrides() {
  const conversation = useConversation({
    onConnect: () => console.log("Connected with overrides"),
    onMessage: (message) => console.log("Message:", message),
  });

  const startWithCustomization = async () => {
    await conversation.startSession({
      agentId: "agent_7901kp0j3ecqfxy8wmj8dwskkejr",
      connectionType: "webrtc",
      overrides: {
        agent: {
          // Custom system prompt
          prompt: {
            prompt: `You are a Kubernetes diagnostics expert. 
                 You help analyze cluster issues and recommend fixes.
                 Be concise and actionable.
                 Always prioritize user safety.`,
          },

          // Custom first message
          firstMessage:
            "Hi! I'm your Kubernetes assistant. What can I help you diagnose today?",

          // Force specific language
          language: "en",
        },
      },
    });
  };

  return (
    <div>
      <button onClick={startWithCustomization}>Start with Customization</button>
    </div>
  );
}

/**
 * Example 3: Advanced Message Handling
 * Send different types of messages during conversation
 */
export function AdvancedMessaging() {
  const conversation = useConversation({
    onConnect: () => console.log("Connected"),
    onMessage: (message) => console.log("Message:", message),
  });

  const sendTextMessage = async () => {
    // Send a user text message (agent can respond)
    await conversation.sendUserMessage(
      "What is the current CPU usage across all nodes?"
    );
  };

  const sendContextualUpdate = async () => {
    // Send context without triggering response
    await conversation.sendContextualUpdate(
      "The user just navigated to the metrics page"
    );
  };

  const sendFeedback = async (isPositive: boolean) => {
    // Send conversation feedback for agent improvement
    await conversation.sendFeedback(isPositive);
  };

  const signalActivity = async () => {
    // Tell agent user is actively engaged
    await conversation.sendUserActivity();
  };

  return (
    <div className="space-y-4">
      <button onClick={sendTextMessage}>Send Text</button>
      <button onClick={sendContextualUpdate}>Send Context</button>
      <button onClick={() => sendFeedback(true)}>Positive Feedback</button>
      <button onClick={() => sendFeedback(false)}>Negative Feedback</button>
      <button onClick={signalActivity}>Signal Activity</button>
    </div>
  );
}

/**
 * Example 4: Complete Advanced Component
 * All features combined
 */
export function AdvancedAgentComponent() {
  const [messages, setMessages] = useState<any[]>([]);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const clientTools = {
    analyze_pod: async (podName: string) => {
      console.log(`Analyzing pod: ${podName}`);
      return `Pod ${podName} is running normally with 2 replicas.`;
    },
  };

  const conversation = useConversation({
    onConnect: () => {
      console.log("Advanced agent connected");
      // Announce connection
      new Audio("/notification.mp3").play();
    },

    onDisconnect: () => {
      console.log("Advanced agent disconnected");
      // Handle cleanup
      setIsSpeaking(false);
    },

    onMessage: (message) => {
      console.log("Raw message:", message);

      if (message.role === "user") {
        setMessages((prev) => [
          ...prev,
          {
            type: "user",
            content: message.message,
          },
        ]);
      } else if (message.role === "agent") {
        setMessages((prev) => [
          ...prev,
          {
            type: "agent",
            content: message.message,
          },
        ]);
      }
    },

    onError: (error) => {
      console.error("Agent error:", error);
      alert(`Error: ${String(error)}`);
    },

    onModeChange: (mode) => {
      console.log("Agent mode changed to:", mode);
      setIsSpeaking(mode.mode === "speaking");
    },
  });

  const startAdvanced = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });

      await conversation.startSession({
        agentId: "agent_7901kp0j3ecqfxy8wmj8dwskkejr",
        connectionType: "webrtc",
        clientTools,
        overrides: {
          agent: {
            prompt: {
              prompt: `You are a Kubernetes expert. Help diagnose cluster issues.
                   Use available tools to analyze pods and metrics.
                   Always explain your reasoning.`,
            },
            firstMessage:
              "Hello! I'm ready to help diagnose your Kubernetes cluster.",
            language: "en",
          },
        },
      });

      // Send initial context
      await conversation.sendContextualUpdate("User started conversation");

      // Set volume
      await conversation.setVolume({ volume: 0.8 });
    } catch (error) {
      console.error("Failed to start:", error);
    }
  };

  return (
    <div className="p-6">
      <h1>Advanced Agent Interface</h1>

      {/* Message History */}
      <div className="message-history bg-gray-100 p-4 rounded mb-4 h-96 overflow-y-auto">
        {messages.map((msg, idx) => (
          <div key={idx} className={`mb-2 ${msg.type === "user" ? "text-blue-600" : "text-green-600"}`}>
            <strong>{msg.type === "user" ? "You" : "Agent"}:</strong> {msg.content}
            {msg.confidence && <span className="text-xs opacity-50"> ({(msg.confidence * 100).toFixed(0)}%)</span>}
          </div>
        ))}
      </div>

      {/* Status */}
      <div className="mb-4 p-3 bg-blue-50 rounded">
        <p>
          Status: <strong>{conversation.status}</strong>
        </p>
        <p>
          {isSpeaking ? "🔴 Agent Speaking" : "🎤 Listening"}
        </p>
      </div>

      {/* Controls */}
      <div className="flex gap-2">
        {conversation.status !== "connected" ? (
          <button
            onClick={startAdvanced}
            className="bg-green-500 text-white px-6 py-2 rounded hover:bg-green-600"
          >
            Start Advanced Session
          </button>
        ) : (
          <>
            <button
              onClick={() => conversation.endSession()}
              className="bg-red-500 text-white px-6 py-2 rounded hover:bg-red-600"
            >
              End Session
            </button>
            <button
              onClick={() => conversation.sendContextualUpdate("User paused")}
              className="bg-yellow-500 text-white px-6 py-2 rounded hover:bg-yellow-600"
            >
              Pause
            </button>
            <button
              onClick={() => conversation.sendFeedback(true)}
              className="bg-blue-500 text-white px-6 py-2 rounded hover:bg-blue-600"
            >
              Thumbs Up
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Usage Notes:
 *
 * 1. Client Tools:
 *    - Agent can call these functions during conversation
 *    - Useful for analyzing cluster, restarting pods, etc.
 *    - Must return string or JSON.stringify()
 *
 * 2. Overrides:
 *    - Customize behavior per session
 *    - Can change prompt, voice, language dynamically
 *    - Persists for entire conversation
 *
 * 3. Message Types:
 *    - user_transcript: User's spoken message
 *    - agent_response: Agent's response
 *    - audio: Raw audio data
 *    - ping: Keep-alive signal
 *
 * 4. Best Practices:
 *    - Always handle errors
 *    - Provide feedback to users
 *    - Log important events
 *    - Clean up on disconnect
 *    - Test with different audio devices
 *
 * 5. Performance:
 *    - WebRTC is low-latency (recommended)
 *    - Fallback to WebSocket if needed
 *    - Monitor volume levels
 *    - Clear old messages periodically
 */
