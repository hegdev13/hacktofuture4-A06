import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();

    console.log("[ElevenLabs Webhook] Received:", {
      event: payload.event,
      conversationId: payload.conversation_id,
      agentId: payload.agent_id,
      timestamp: new Date().toISOString(),
    });

    // Log the conversation data
    if (payload.messages) {
      console.log("[ElevenLabs Webhook] Conversation messages:", {
        messageCount: payload.messages.length,
        firstMessage: payload.messages[0],
        lastMessage: payload.messages[payload.messages.length - 1],
      });

      // You can process or store this data here
      // Example: Save to database, send alerts, trigger actions, etc.
    }

    // Return success response
    return NextResponse.json(
      {
        success: true,
        message: "Webhook received successfully",
        conversationId: payload.conversation_id,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[ElevenLabs Webhook] Error:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      endpoint: "/api/webhooks/elevenlabs",
      message: "ElevenLabs webhook endpoint is ready",
      usage: {
        method: "POST",
        contentType: "application/json",
        ngrokUrl: "https://putatively-nonreclaimable-anisha.ngrok-free.app/api/webhooks/elevenlabs",
      },
    },
    { status: 200 }
  );
}
