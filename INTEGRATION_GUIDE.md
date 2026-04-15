# ElevenLabs Agent Integration - Complete Setup Guide

## 🚀 Quick Start

### 1. Installation ✓ (Already Done)
```bash
npm install @elevenlabs/react
```

### 2. Environment Setup
Create `.env.local` in the project root:
```env
NEXT_PUBLIC_ELEVENLABS_AGENT_ID=agent_7901kp0j3ecqfxy8wmj8dwskkejr
NEXT_PUBLIC_NGROK_URL=https://putatively-nonreclaimable-anisha.ngrok-free.app
ELEVENLABS_API_KEY=your_api_key_here
```

### 3. Access the Agent
- **Frontend URL**: http://localhost:3001/conversation
- **Webhook Endpoint**: https://putatively-nonreclaimable-anisha.ngrok-free.app/api/webhooks/elevenlabs

---

## 📁 Project Structure

```
src/
├── app/
│   ├── conversation/
│   │   └── page.tsx              # Main conversation UI
│   └── api/
│       └── webhooks/
│           └── elevenlabs/
│               └── route.ts      # Webhook receiver
├── components/
│   └── ElevenLabsAgent.tsx        # Agent component
└── lib/
    └── elevenlabs.ts             # Utility functions
```

---

## 🔧 Components Overview

### ElevenLabsAgent Component (`/src/components/ElevenLabsAgent.tsx`)
The main React component that handles:
- ✅ Microphone access & permissions
- ✅ WebRTC connection to ElevenLabs
- ✅ Message history display
- ✅ Start/End conversation controls
- ✅ Real-time speaker detection
- ✅ Volume monitoring

**Key Features:**
```tsx
// Start conversation with agent
const startConversation = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  await conversation.startSession({
    agentId: AGENT_ID,
    connectionType: "webrtc",
  });
};

// End conversation
const endConversation = async () => {
  await conversation.endSession();
  setMessages([]);
};
```

### Conversation Page (`/src/app/conversation/page.tsx`)
Dedicated page layout featuring:
- Agent component in a full-featured interface
- Info cards with agent capabilities
- Quick tips for users
- Responsive design

### Webhook Endpoint (`/src/app/api/webhooks/elevenlabs/route.ts`)
Receives conversation callbacks:
- Logs conversation events
- Stores message history
- Triggers downstream actions
- Available at ngrok URL

---

## 🌐 How It Works

### Flow Diagram
```
┌─────────────────────────────────────────────────┐
│        User Browser (localhost:3001)            │
│                                                   │
│  ┌──────────────────────────────────────────┐  │
│  │   ElevenLabsAgent Component              │  │
│  │  - Capture User Voice                    │  │
│  │  - Display Messages                      │  │
│  │  - Show Agent Responses                  │  │
│  └──────┬───────────────────────────────────┘  │
│         │                                       │
│         │  WebRTC                              │
│         ▼                                       │
│  ┌─────────────────────────────────────────┐   │
│  │  ElevenLabs API                         │   │
│  │  (agent_7901kp0j3ecqfxy8wmj8dwskkejr)  │   │
│  └─────────────┬───────────────────────────┘   │
└────────────────┼─────────────────────────────────┘
                 │
                 │  Webhook (on end)
                 ▼
        ┌────────────────────────┐
        │  ngrok Tunnel (active) │
        │ https://putatively-... │
        └────────────┬───────────┘
                     │
                     ▼
        ┌────────────────────────┐
        │  Your Backend          │
        │  /api/webhooks/        │
        │    elevenlabs          │
        └────────────────────────┘
```

### Message Flow
1. **User speaks** → Browser captures audio
2. **WebRTC sends** → Audio to ElevenLabs
3. **Agent processes** → Returns response
4. **Browser receives** → Displays message
5. **On disconnect** → Conversation webhook fired to your ngrok URL

---

## 🎯 Integration Examples

### 1. Basic Usage (Already Implemented)
```tsx
import ElevenLabsAgent from "@/components/ElevenLabsAgent";

export default function ConversationPage() {
  return <ElevenLabsAgent />;
}
```

### 2. Custom Implementation
```tsx
"use client";
import { useConversation } from "@elevenlabs/react";

export function CustomAgent() {
  const conversation = useConversation({
    onMessage: (msg) => {
      if (msg.type === "user_transcript") {
        // Handle user message
        console.log("User said:", msg.user_transcript);
      }
    },
    onConnect: () => console.log("Connected"),
    onError: (err) => console.error("Error:", err),
  });

  return (
    <button onClick={() => 
      conversation.startSession({ agentId: "agent_7901kp0j3ecqfxy8wmj8dwskkejr" })
    }>
      Start
    </button>
  );
}
```

### 3. Webhook Integration
```tsx
// Send data to your backend when conversation ends
const sendConversationWebhook = async (data: {
  conversationId: string;
  messages: ConversationMessage[];
  agentId: string;
  duration: number;
}) => {
  await fetch(
    "https://putatively-nonreclaimable-anisha.ngrok-free.app/api/webhooks/elevenlabs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "conversation_ended",
        ...data,
      }),
    }
  );
};
```

---

## 📊 Webhook Payload Examples

### Conversation Started
```json
{
  "event": "conversation_started",
  "conversation_id": "conv_abc123",
  "agent_id": "agent_7901kp0j3ecqfxy8wmj8dwskkejr",
  "timestamp": "2024-04-12T10:30:00Z"
}
```

### Conversation Ended
```json
{
  "event": "conversation_ended",
  "conversation_id": "conv_abc123",
  "agent_id": "agent_7901kp0j3ecqfxy8wmj8dwskkejr",
  "duration": 125,
  "messages": [
    {
      "type": "user",
      "content": "What is the pod status?",
      "timestamp": "2024-04-12T10:30:00Z"
    },
    {
      "type": "agent",
      "content": "All pods are running normally",
      "timestamp": "2024-04-12T10:30:02Z"
    }
  ]
}
```

---

## 🔐 Security Considerations

### Microphone Permissions
- Users will be prompted for microphone access
- Handle gracefully if permission denied
- Fallback to text-based interaction possible

### API Keys
- Keep `ELEVENLABS_API_KEY` in `.env.local` (not in Git)
- Use `NEXT_PUBLIC_*` only for public values
- Consider server-side token generation for production

### Webhook Security (Optional)
Add verification in your webhook endpoint:
```tsx
// Verify ngrok signature (if configured)
const verifyWebhook = (req: NextRequest) => {
  const signature = req.headers.get("ngrok-signature-version");
  // Implement verification logic
};
```

---

## 🐛 Troubleshooting

### Issue: "Microphone permission denied"
**Solution:**
- Check browser permissions settings
- Clear site data and try again
- Try incognito/private window
- Check if browser has mic access globally

### Issue: "WebRTC connection failed"
**Solution:**
- Verify agent ID is correct
- Check network connectivity
- Ensure WebRTC is supported in browser
- Check browser console for detailed errors

### Issue: "No audio from agent"
**Solution:**
- Check speaker volume
- Verify system audio output
- Try different browser
- Check ElevenLabs status page

### Issue: "Webhook not being called"
**Solution:**
- Verify ngrok is running: `ngrok http 3000`
- Test endpoint manually: `curl https://putatively-.../api/webhooks/elevenlabs`
- Check conversation actually ends
- Verify network connectivity

---

## 📝 Usage Tips

### Best Practices
1. **Handle errors gracefully** - Provide fallback UI
2. **Monitor volume levels** - Prevent audio issues
3. **Log conversations** - For debugging & improvement
4. **Clear messages periodically** - Prevent memory issues
5. **Test microphone access** - Before conversation starts

### Advanced Features
- **Client Tools**: Define custom functions agent can call
- **Overrides**: Customize prompt, voice, language per session
- **Context Updates**: Send non-interrupting context to agent
- **User Feedback**: Let agent improve based on feedback

---

## 🚀 Next Steps

1. **Set up environment variables** ✓
2. **Access conversation page** → http://localhost:3001/conversation
3. **Test microphone access** → Click "Start Conversation"
4. **Speak to agent** → Ask about your cluster
5. **Monitor webhook** → Check ngrok dashboard at http://127.0.0.1:4040
6. **Customize agent** → Update prompt/capabilities in ElevenLabs dashboard

---

## 📚 Reference Documentation

- [ElevenLabs Agents Docs](https://elevenlabs.io/docs/eleven-agents)
- [React SDK Reference](https://elevenlabs.io/docs/react)
- [API Reference](https://elevenlabs.io/docs/api-reference)
- [WebRTC Connection Guide](https://elevenlabs.io/docs/api-reference/conversations/initiate-a-web-rtc-connection)
- [ngrok Documentation](https://ngrok.com/docs)

---

## 📞 Support

For issues or questions:
1. Check the troubleshooting section above
2. Review ElevenLabs documentation
3. Check browser console for error messages
4. Test webhook connectivity with curl
5. Monitor ngrok dashboard for incoming requests
