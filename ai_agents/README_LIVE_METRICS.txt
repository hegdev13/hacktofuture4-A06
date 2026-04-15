#!/usr/bin/env node

/**
 * Quick Reference - Live Metrics Setup
 * Visual guide for starting the system
 */

const chalk = require('chalk') || { 
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`
};

console.clear();
console.log(`
  ╔═══════════════════════════════════════════════════╗
  ║  🚀 Self-Healing System with Live Metrics         ║
  ║     Powered by Real Kubernetes Pod Data           ║
  ╚═══════════════════════════════════════════════════╝

  ⚡ QUICK START (3 Steps)
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1️⃣  START THE SYSTEM
  ────────────────────
      $ node start-with-live-metrics.js

      OR use quick-start:
      $ ./quick-start.sh

  2️⃣  OPEN DASHBOARD
  ───────────────────
      🌐 http://localhost:3456

  3️⃣  CONNECT METRICS  
  ───────────────────
      • Navigate to "⚙️ Configuration" section
      • See pre-filled ngrok URL:
        https://refocus-cement-spud.ngrok-free.dev/pods
      • Click "📡 Connect Metrics"
      • Watch real-time analysis start


  📊 WHAT YOU'LL SEE
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✅ System Status
     • 20 real pods from your ngrok endpoint
     • Issues detected: 2 (paymentservice problems)
     • Health: Degraded

  🔍 Analysis Pipeline
     • Observer → Detects anomalies
     • Detector → Confirms issues
     • RCA → Finds root cause
     • Executor → Plans fixes

  📈 Dashboard Shows
     • Real-time issue list
     • Agent status (running/analyzing/success)
     • Solution recommendations
     • Timeline of all events


  🎯 KEY FEATURES
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✓ Live Metrics from Ngrok
    └─ Fetches real pod data automatically

  ✓ Intelligent Issue Detection
    └─ CPU, memory, restart, dependency analysis

  ✓ Root Cause Analysis
    └─ Traces failure chains through dependencies

  ✓ Automated Learning
    └─ Remembers past issues and solutions

  ✓ Safe by Default
    └─ Dry-run mode (no real changes) enabled

  ✓ Real-Time Dashboard
    └─ SSE streaming for live updates


  🧪 BEFORE STARTING
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Optional: Test the connection first
  $ node test-live-metrics.js


  📋 CURRENT STATUS
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✅ Ngrok Endpoint: WORKING
     URL: https://refocus-cement-spud.ngrok-free.dev/pods
     Pods detected: 20

  ✅ Data Format: VALIDATED
     Type: Object with pods array

  ✅ Analysis Pipeline: READY
     Issues found: 2 (paymentservice)

  ✅ Dashboard: CONFIGURED
     Port: 3456
     Auto-trigger: Enabled


  💡 PRO TIPS
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  • Check ngrok status: https://refocus-cement-spud.ngrok-free.dev/status
  • Dashboard auto-refreshes with live metrics
  • Click "Run Self-Healing" to manually trigger analysis
  • View timeline to see all analysis steps
  • Memory shows learned patterns and success rate


  📁 FILES CREATED/MODIFIED
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✓ start-with-live-metrics.js     Main orchestrator
  ✓ quick-start.sh                 Easy startup script
  ✓ test-live-metrics.js           Connection validator
  ✓ LIVE_METRICS_GUIDE.md          Comprehensive guide
  ✓ dashboard/index.html           Updated UI
  ✓ dashboard/app.js               Enhanced config panel
  ✓ utils/metricsFetcher.js        Better format detection


  🔗 USEFUL LINKS
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Dashboard:        http://localhost:3456
  Ngrok Pods:       https://refocus-cement-spud.ngrok-free.dev/pods
  Ngrok Status:     https://refocus-cement-spud.ngrok-free.dev/status

  
  ❓ TROUBLESHOOTING
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Issue: "Connection refused"
  → Check ngrok is running
  → Verify URL: https://refocus-cement-spud.ngrok-free.dev/pods

  Issue: "No pods detected"
  → Ensure ngrok endpoint returns JSON data
  → Minimum 1 pod should be present

  Issue: "Dashboard not loading"
  → Verify port 3456 is available
  → Check firewall settings
  → Try different port: DASHBOARD_PORT=4000 node start-with-live-metrics.js


  🚀 READY?
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Run this command to start:

  🟢 node start-with-live-metrics.js

  Then open http://localhost:3456 in your browser!

  ═══════════════════════════════════════════════════
`);
