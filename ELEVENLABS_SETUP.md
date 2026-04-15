# ElevenLabs Integration Configuration

## Environment Variables

Create a `.env.local` file in the project root with:

```
# ElevenLabs Agent Configuration
NEXT_PUBLIC_ELEVENLABS_AGENT_ID=agent_7901kp0j3ecqfxy8wmj8dwskkejr
ELEVENLABS_API_KEY=your_api_key_here
```

## Configuration Guide

### Agent ID
- **Agent Name**: kubernetes
- **Agent ID**: `agent_7901kp0j3ecqfxy8wmj8dwskkejr`
- **Connection Type**: WebRTC (recommended for low-latency)

### Features Enabled
- ✅ Voice I/O with WebRTC
- ✅ Real-time transcription
- ✅ Message history
- ✅ Volume monitoring
- ✅ Connection status tracking
- ✅ Error handling & recovery

## Integration Points

### 1. Direct Component Usage
```tsx
import ElevenLabsAgent from "@/components/ElevenLabsAgent";

export default function Page() {
  return <ElevenLabsAgent />;
}
```

### 2. Dedicated Page
Navigate to `/conversation` to access the full-featured agent interface

### 3. Webhook Configuration (Optional)
For backend integration with your ngrok endpoint:

**Ngrok URL**: `https://putatively-nonreclaimable-anisha.ngrok-free.app`

You can configure ElevenLabs webhooks to:
- Send conversation transcripts
- Trigger custom workflows
- Log conversation events
- Send metrics to your backend

### Webhook Payload Example
```json
{
  "conversation_id": "conv_xxx",
  "agent_id": "agent_7901kp0j3ecqfxy8wmj8dwskkejr",
  "messages": [
    {
      "role": "user",
      "content": "What is the status?",
      "timestamp": "2024-04-12T10:30:00Z"
    },
    {
      "role": "agent",
      "content": "All pods are running normally",
      "timestamp": "2024-04-12T10:30:02Z"
    }
  ]
}
```

## API Reference

### useConversation Hook
```tsx
const conversation = useConversation({
  onConnect: () => {},
  onDisconnect: () => {},
  onMessage: (message) => {},
  onError: (error) => {},
  onModeChange: (mode) => {},
});
```

#### Available Methods
- `conversation.startSession({ agentId, connectionType })`
- `conversation.endSession()`
- `conversation.sendUserMessage(text)`
- `conversation.sendContextualUpdate(text)`
- `conversation.sendFeedback(isPositive)`
- `conversation.setVolume({ volume: 0.5 })`
- `conversation.getInputVolume()`
- `conversation.getOutputVolume()`

#### Status Values
- `idle` - Not connected
- `connecting` - Establishing connection
- `connected` - Active session
- `disconnecting` - Closing session

## Testing

### Local Testing
1. Run: `npm run dev`
2. Navigate to: `http://localhost:3001/conversation`
3. Click "Start Conversation"
4. Speak naturally to the agent

### Remote Testing via ngrok
The ngrok tunnel is already running. You can test the webhook integration:

```bash
curl -X POST https://putatively-nonreclaimable-anisha.ngrok-free.app/api/webhook \
  -H "Content-Type: application/json" \
  -d '{"event": "conversation_started", "agent_id": "agent_7901kp0j3ecqfxy8wmj8dwskkejr"}'
```

## Troubleshooting

### Microphone Permission Denied
- Check browser permissions
- Allow access when prompted
- Try a different browser

### Connection Fails
- Verify agent ID is correct
- Check network connectivity
- Ensure WebRTC is supported

### No Audio Output
- Check speaker volume
- Verify audio permissions
- Check browser console for errors

## Documentation Links

- [ElevenLabs Docs](https://elevenlabs.io/docs/eleven-agents)
- [React SDK Docs](https://elevenlabs.io/docs/react)
- [API Reference](https://elevenlabs.io/docs/api-reference/introduction)
- [Conversations API](https://elevenlabs.io/docs/api-reference/conversations/get)
