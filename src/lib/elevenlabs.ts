/**
 * ElevenLabs Conversational AI Utilities
 * Helper functions for managing conversations and messages
 */

export const ELEVENLABS_CONFIG = {
  AGENT_ID: process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID || "agent_7901kp0j3ecqfxy8wmj8dwskkejr",
  API_KEY: process.env.ELEVENLABS_API_KEY,
  CONNECTION_TYPE: "webrtc" as const,
  DEFAULT_LANGUAGE: "en",
};

export interface ConversationMessage {
  type: "user" | "agent";
  content: string;
  timestamp: Date;
  transcription?: string;
  confidence?: number;
}

export interface ConversationState {
  isConnected: boolean;
  isLoading: boolean;
  isSpeaking: boolean;
  messages: ConversationMessage[];
  inputVolume: number;
  outputVolume: number;
  error?: string;
}

/**
 * Format message for display
 */
export const formatMessage = (message: ConversationMessage): string => {
  return `[${message.timestamp.toLocaleTimeString()}] ${message.type === "user" ? "You" : "Agent"}: ${message.content}`;
};

/**
 * Parse incoming message from ElevenLabs
 */
export const parseElevenLabsMessage = (rawMessage: any): ConversationMessage | null => {
  if (rawMessage.type === "user_transcript") {
    return {
      type: "user",
      content: rawMessage.user_transcript,
      timestamp: new Date(),
      transcription: rawMessage.user_transcript,
      confidence: rawMessage.confidence,
    };
  }

  if (rawMessage.type === "agent_response") {
    return {
      type: "agent",
      content: rawMessage.agent_response,
      timestamp: new Date(),
    };
  }

  return null;
};

/**
 * Get the ngrok webhook URL for this conversation
 */
export const getNgrokWebhookUrl = (): string => {
  const baseUrl = process.env.NEXT_PUBLIC_NGROK_URL || "https://putatively-nonreclaimable-anisha.ngrok-free.app";
  return `${baseUrl}/api/webhooks/elevenlabs`;
};

/**
 * Send conversation data to webhook
 */
export const sendConversationWebhook = async (data: {
  conversationId: string;
  messages: ConversationMessage[];
  agentId: string;
  duration: number;
}): Promise<void> => {
  try {
    const webhookUrl = getNgrokWebhookUrl();

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event: "conversation_ended",
        conversation_id: data.conversationId,
        agent_id: data.agentId,
        messages: data.messages,
        duration: data.duration,
        timestamp: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      console.error("Webhook error:", response.statusText);
    }
  } catch (error) {
    console.error("Failed to send webhook:", error);
  }
};

/**
 * Format duration in seconds to readable string
 */
export const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${minutes}m ${secs}s`;
};

/**
 * Generate conversation summary from messages
 */
export const generateConversationSummary = (messages: ConversationMessage[]): string => {
  const userMessages = messages.filter((m) => m.type === "user");
  const agentMessages = messages.filter((m) => m.type === "agent");

  const summary = {
    totalMessages: messages.length,
    userQuestions: userMessages.length,
    agentResponses: agentMessages.length,
    duration: messages.length > 0
      ? new Date(messages[messages.length - 1].timestamp).getTime() - new Date(messages[0].timestamp).getTime()
      : 0,
  };

  return JSON.stringify(summary, null, 2);
};

/**
 * Extract action items from conversation
 */
export const extractActionItems = (messages: ConversationMessage[]): string[] => {
  const actionPatterns = [
    /restart/i,
    /heal/i,
    /fix/i,
    /update/i,
    /deploy/i,
    /check/i,
  ];

  const actionItems: string[] = [];

  messages.forEach((msg) => {
    if (msg.type === "agent") {
      actionPatterns.forEach((pattern) => {
        if (pattern.test(msg.content)) {
          actionItems.push(msg.content);
        }
      });
    }
  });

  return actionItems;
};
