# ElevenLabs Integration - Deployment Checklist

## Pre-Deployment Review

### ✅ Code Quality
- [ ] No console errors in development
- [ ] All imports resolved correctly
- [ ] TypeScript types are correct
- [ ] No unused variables or imports
- [ ] Components render without warnings

### ✅ Environment Configuration
- [ ] `.env.local` created from `.env.example`
- [ ] `ELEVENLABS_API_KEY` is set
- [ ] `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` confirmed
- [ ] `NEXT_PUBLIC_NGROK_URL` is correct
- [ ] No secrets exposed in code

### ✅ Testing
- [ ] Microphone access works on target device
- [ ] Can successfully connect to agent
- [ ] Voice input and output working
- [ ] Message history displays correctly
- [ ] Can gracefully disconnect
- [ ] Error handling tested (deny permissions, network errors, etc.)

### ✅ WebRTC & Audio
- [ ] WebRTC connection established
- [ ] Audio encoding/decoding works
- [ ] Volume levels reasonable
- [ ] No audio feedback/echo
- [ ] Works on target browsers

### ✅ Webhook Integration
- [ ] ngrok tunnel is running and stable
- [ ] Webhook endpoint responds to POST requests
- [ ] Messages are being logged/stored
- [ ] Can handle concurrent conversations
- [ ] Rate limiting considered (if needed)

### ✅ Security
- [ ] API keys not in git history
- [ ] Environment variables properly set
- [ ] HTTPS enabled (ngrok provides this)
- [ ] Microphone permissions properly handled
- [ ] User data privacy considered

### ✅ Browser Compatibility
- [ ] Chrome/Chromium ✓
- [ ] Firefox ✓
- [ ] Safari ✓
- [ ] Edge ✓
- [ ] Mobile browsers (iOS Safari, Chrome Mobile) ✓

### ✅ Performance
- [ ] Page loads in < 3 seconds
- [ ] WebRTC connection established in < 1 second
- [ ] Agent responds in < 2 seconds
- [ ] No memory leaks on long conversations
- [ ] UI remains responsive

---

## Deployment Steps

### 1. Production Build
```bash
# Build the application
npm run build

# Test production build locally
npm run start

# Visit http://localhost:3000/conversation to test
```

### 2. Environment Setup
```bash
# Ensure all production environment variables are set
# All NEXT_PUBLIC_* variables should be accessible to frontend
# All non-public variables should be secure on backend
```

### 3. Deploy to Hosting
```bash
# Deploy using your preferred platform:
# - Vercel (recommended for Next.js)
# - AWS Amplify
# - Google Cloud Run
# - Azure App Service
# - Docker on any cloud provider

# Example Vercel deployment:
# npx vercel --prod
```

### 4. ngrok Configuration for Production
```bash
# Option A: Keep current setup
# - ngrok running on your machine
# - Webhook forwards to development environment
# - Good for demos/beta

# Option B: Permanent ngrok tunnel
# - Subscribe to ngrok paid plan for permanent URL
# - More reliable for production

# Option C: Self-hosted webhook server
# - Replace ngrok URL with your own server
# - More control and scalability
```

### 5. Verify Deployment
```bash
# Test the deployed application
curl https://your-domain.com/conversation

# Test webhook endpoint
curl -X POST https://your-domain.com/api/webhooks/elevenlabs \
  -H "Content-Type: application/json" \
  -d '{"test": true}'

# Confirm agent is accessible
# Visit conversation page and test
```

---

## Post-Deployment Configuration

### Update Webhook URL (if changed)
```env
# In production .env or deployment platform:
NEXT_PUBLIC_NGROK_URL=your_production_webhook_url
```

### Configure ElevenLabs Dashboard
1. Log in to https://elevenlabs.io/app
2. Go to your agent settings
3. Set webhook endpoint to: `https://your-domain.com/api/webhooks/elevenlabs`
4. Configure webhook events (optional)

### Set Up Monitoring
- [ ] Monitor webhook delivery in ngrok dashboard
- [ ] Log all webhook requests to database
- [ ] Set up alerts for failed connections
- [ ] Track conversation metrics
- [ ] Monitor error rates

### Analytics Setup (Optional)
```tsx
// Add tracking to track usage
// Example: Amplitude, Mixpanel, or custom analytics

const trackConversationStart = () => {
  if (typeof window !== 'undefined' && window.analytics) {
    window.analytics.track('conversation_started', {
      agentId: AGENT_ID,
      timestamp: new Date(),
    });
  }
};

const trackConversationEnd = (duration: number) => {
  if (typeof window !== 'undefined' && window.analytics) {
    window.analytics.track('conversation_ended', {
      agentId: AGENT_ID,
      duration,
      timestamp: new Date(),
    });
  }
};
```

---

## Troubleshooting in Production

### Issue: Webhook not receiving data
- [ ] Verify webhook endpoint is publicly accessible
- [ ] Check firewall/security groups allow traffic
- [ ] Verify ngrok/tunnel is still active
- [ ] Check logs for connection errors
- [ ] Test with curl command

### Issue: High latency
- [ ] Check network connectivity
- [ ] Verify WebRTC connection (chrome://webrtc-internals)
- [ ] Monitor browser console for warnings
- [ ] Consider closer ngrok server region

### Issue: Conversations not starting
- [ ] Verify ELEVENLABS_API_KEY is valid
- [ ] Check agent ID is correct
- [ ] Verify microphone permissions on device
- [ ] Check browser console for errors
- [ ] Test with different browsers

### Issue: Memory issues on long conversations
- [ ] Implement message history pruning
- [ ] Clear old messages periodically
- [ ] Monitor browser dev tools memory tab
- [ ] Implement pagination for message list

---

## Rollback Plan

If deployment has issues:

```bash
# Revert to previous version
git revert <commit-hash>
npm run build
npm run start

# Or use deployment platform's rollback
# (Vercel, AWS, etc. all have rollback options)
```

---

## Maintenance Tasks

### Regular Checks
- [ ] Monitor webhook delivery success rate
- [ ] Check for JavaScript errors in production
- [ ] Review conversation analytics
- [ ] Update dependencies monthly

### Monthly Tasks
```bash
# Check for security updates
npm audit

# Update packages
npm update

# Run tests
npm run test (if applicable)
```

### Quarterly Tasks
- [ ] Review and update documentation
- [ ] Analyze conversation quality
- [ ] Check for breaking API changes from ElevenLabs
- [ ] Review security best practices

---

## Performance Optimization

### Frontend
- [ ] Code splitting for components
- [ ] Lazy load ElevenLabs SDK
- [ ] Optimize bundle size
- [ ] Cache static assets
- [ ] Enable gzip compression

### Backend
- [ ] Cache webhook responses
- [ ] Implement rate limiting
- [ ] Database indexing for conversations
- [ ] Connection pooling

### Network
- [ ] Use CDN for static assets
- [ ] Enable HTTP/2
- [ ] Consider edge functions
- [ ] Optimize WebRTC routing

---

## Scaling Considerations

As usage grows:

1. **Database**: Store all conversation data
   ```sql
   CREATE TABLE conversations (
     id UUID PRIMARY KEY,
     agent_id VARCHAR(255),
     user_id VARCHAR(255),
     messages JSONB,
     duration INT,
     created_at TIMESTAMP,
     ended_at TIMESTAMP
   );
   ```

2. **Message Queue**: Handle high webhook volume
   - Use Redis, RabbitMQ, or Kafka
   - Decouple webhook processing

3. **Microservices**: Split components
   - Webhook service
   - Analytics service
   - Agent service

4. **Load Balancing**: Distribute traffic
   - Multiple instances behind load balancer
   - Geographic distribution with CDN

---

## Security Checklist

- [ ] API key never logged or exposed
- [ ] HTTPS enforced everywhere
- [ ] CORS properly configured
- [ ] Rate limiting implemented
- [ ] Input validation on webhooks
- [ ] SQL injection prevention (if using DB)
- [ ] XSS protection enabled
- [ ] CSRF tokens if applicable
- [ ] Regular security audits
- [ ] Dependency vulnerability scanning

---

## Success Metrics

After deployment, track:

- [ ] Uptime > 99.9%
- [ ] Connection success rate > 98%
- [ ] Average response time < 2s
- [ ] User satisfaction score > 4/5
- [ ] Zero critical security issues
- [ ] Webhook delivery success > 95%

---

## Support & Documentation

Ensure these are available to users:
- [ ] User guide for starting conversations
- [ ] Troubleshooting FAQ
- [ ] Support email/contact
- [ ] Known issues list
- [ ] API documentation
- [ ] Webhook format documentation

---

**Last Updated**: 12 April 2026
**Deployment Status**: Ready for staging/production
**Dependencies**: All installed and verified
**ngrok Status**: Active and running
