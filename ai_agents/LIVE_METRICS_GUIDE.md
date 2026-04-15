# Self-Healing System - Live Metrics Setup Guide

## Quick Start with Live Ngrok Metrics

### 1. **Connect Your Ngrok Endpoint**

Your ngrok metrics endpoint is ready at:
```
https://refocus-cement-spud.ngrok-free.dev/pods
```

### 2. **Start the System**

```bash
# Start with live metrics (recommended)
node start-with-live-metrics.js

# Or use environment variable
NGROK_URL=https://refocus-cement-spud.ngrok-free.dev/pods node start-with-live-metrics.js
```

### 3. **Open Dashboard**

Open your browser to: **http://localhost:3456**

### 4. **Connect Metrics in Dashboard**

You'll see the Configuration panel at the top with:

```
⚙️ Configuration
┌─────────────────────────────────────────────┐
│  Metrics Endpoint URL (Ngrok)               │
│  [https://refocus-cement-spud.ngrok...] 📡  │
│                                              │
│  [Connect Metrics]                           │
└─────────────────────────────────────────────┘
```

**Options:**

a) **Pre-configured Ngrok URL** (auto-populated):
   - If you set `NGROK_URL` environment variable
   - Click "Connect Metrics"

b) **Manual Entry:**
   - Paste your ngrok URL: `https://refocus-cement-spud.ngrok-free.dev/pods`
   - Click "Connect Metrics"
   - Dashboard shows: ✅ Real-time metrics connected!

### 5. **Run Analysis**

After connecting metrics:
- **Auto-triggers** analysis automatically (2-second delay)
- OR manually click "Run Self-Healing" button

---

## System Features with Live Metrics

### 📊 Real-Time Analysis Pipeline

```
Live Pods ──→ Observer   ──→ Detector  ──→ RCA  ──→ Executor ──→ Results
(Ngrok)      (Detect)       (Confirm)     (RCA)     (Fix)
```

### 🎯 Analysis Components Working with Live Data

| Component | What It Does | Live Data Support |
|-----------|-------------|-------------------|
| **Observer** | Detects anomalies (CPU, memory, restarts) | ✅ Analyzes live pod metrics |
| **Detector** | Confirms issues, filters false positives | ✅ Re-validates against ngrok data |
| **RCA** | Traces root cause through dependencies | ✅ Maps dependency chains |
| **Executor** | Plans/executes fixes | ✅ Simulates actions (dry-run mode) |
| **Memory** | Learns from past issues | ✅ Tracks solutions from live incidents |

### 📈 Dashboard Displays

- **System Health**: Real-time status (Healthy/Degraded/Critical)
- **Live Issues**: Pod problems detected from ngrok data
- **Agent Status**: Observer → Detector → RCA → Executor progress
- **Timeline**: Real-time event log of analysis steps
- **Recommendations**: Suggested fixes based on RCA analysis
- **Memory Stats**: Success rate, learned patterns

---

## Advanced Usage

### Environment Variables

```bash
# Metrics endpoint
export NGROK_URL=https://refocus-cement-spud.ngrok-free.dev/pods

# Dashboard port
export DASHBOARD_PORT=3456

# Dry-run mode (safe, doesn't execute fixes)
export DRY_RUN=true

# Auto-run analysis on startup
export AUTO_RUN=true

# Full execution (real fixes)
export DRY_RUN=false
```

### Start With All Options

```bash
NGROK_URL=https://refocus-cement-spud.ngrok-free.dev/pods \
DASHBOARD_PORT=3456 \
DRY_RUN=true \
node start-with-live-metrics.js
```

---

## How Live Metrics Work

### 1. **Metrics Flow**

```
┌──────────────┐
│  Ngrok Pods  │  (Your live cluster data)
│  /pods       │  Format: JSON array of pod objects
└──────┬───────┘
       │ HTTPS Request (cached for 5 seconds)
       ↓
┌──────────────────────────┐
│  MetricsFetcher          │
│  - Handles ngrok format  │
│  - Auto-detects format   │
│  - Normalizes to internal│
└──────┬───────────────────┘
       │ Normalized state
       ↓
┌──────────────────────────┐
│  Self-Healing System     │
│  - Observer analyzes     │
│  - Detector confirms     │
│  - RCA finds root cause  │
│  - Executor plans fix    │
└──────┬───────────────────┘
       │ Analysis results
       ↓
┌──────────────────────────┐
│  Dashboard               │
│  - Real-time updates     │
│  - Results visualization │
│  - Control interface     │
└──────────────────────────┘
```

### 2. **Data Format Support**

The system auto-detects and handles:

- ✅ **ngrok /pods** (array of pods)
- ✅ **Kubernetes** (K8s-style objects)
- ✅ **Prometheus** (metrics format)
- ✅ **Custom** (flexible structure)

### 3. **What the System Analyzes from Live Data**

```javascript
For each pod:
├─ Status & Health
│  ├─ Running/Pending/Failed/CrashLoop
│  ├─ Restart count
│  └─ Ready status
├─ Resource Usage
│  ├─ CPU percentage
│  ├─ Memory percentage
│  └─ OOM kills
├─ Dependencies
│  ├─ Database connections
│  ├─ Cache services
│  ├─ Message queues
│  └─ API dependencies
└─ Cascading Failures
   ├─ Dependent pods affected
   ├─ Service impact
   └─ Recovery recommendations
```

---

## Example Scenarios

### Scenario 1: High CPU Detection

```
Dashboard shows:
├─ 🔴 Issue: api-server CPU at 92%
├─ Agent: Observer → Detector → RCA
├─ RCA Result: Root cause = memory leak in v2.1.0
├─ Action: Scale pod replicas from 2 → 3
└─ Status: ✅ Fixed (new pod absorbs traffic)
```

### Scenario 2: Dependent Service Failure

```
Dashboard shows:
├─ 🔴 Issue: database-primary pod stopped
├─ 🔴 Cascading: cache-redis, query-service dependent
├─ Agent Analysis: 
│  ├─ Observer: Detects 3 failing pods
│  ├─ Detector: Confirms all related
│  ├─ RCA: database-primary is root cause
│  └─ Executor: Restart database first
├─ Action: Restart database-primary pod
├─ Result: ✅ Cache reconnects, services recover
└─ Timeline: 15 seconds total fix time
```

### Scenario 3: Memory Pressure

```
Dashboard shows:
├─ 🟡 Issue: worker-1 memory at 87%
├─ Agent: Observer → Detector (low priority)
├─ Result: Monitor trend, no action yet
├─ Next Iteration: If reaches 95%, scale
└─ Status: ⏳ Monitoring...
```

---

## Monitoring Dashboard

### Real-Time Sections

1. **System Overview**
   - Health indicator (Healthy/Degraded/Critical)
   - Total issues count
   - Success rate from memory

2. **Live Issues**
   - Pod name and namespace
   - Problem type (high_restart_count, oom_kill, etc.)
   - Severity (low/medium/high)
   - Metric details

3. **Agent Status**
   - Observer: Analyzing
   - Detector: Confirming
   - RCA: Finding root cause
   - Executor: Executing fix

4. **Timeline Events**
   - Step-by-step analysis progress
   - Fix execution details
   - Results and recommendations

5. **Memory & Learning**
   - Total patterns learned
   - Success rate percentage
   - Similar past issues

---

## Troubleshooting

### "Connection Failed" Message

```
✓ Check ngrok URL is correct
✓ Verify ngrok is running: https://refocus-cement-spud.ngrok-free.dev/status
✓ Network connectivity to ngrok
✓ URL format: https://... (must be HTTPS)
```

### No Pods Detected

```
✓ Ngrok endpoint returns JSON array of pods
✓ Check response format: [{ name: "...", status: "..." }, ...]
✓ At least one pod should be present
```

### Metrics Update Slowly

```
✓ System caches metrics for 5 seconds
✓ This prevents excessive API calls
✓ Click "Run Self-Healing" to force refresh
```

---

## Testing with Mock Data (No Ngrok Needed)

If ngrok URL is not configured, system falls back to mock scenarios:

```bash
# Run in mock/demo mode
node self-healing-system/main.js

# Cycles through scenarios:
# 1. Healthy cluster
# 2. High CPU alert
# 3. CrashLoop detection
# 4. Dependency failure
# 5. Cascading failure
```

---

## How to Extend

### Add Custom Analysis

Edit [self-healing-system/agents/observer.js](self-healing-system/agents/observer.js):

```javascript
// Add custom detection logic
if (pod.custom_metric > threshold) {
  issues.push({
    severity: 'high',
    problem: 'custom_issue',
    target: pod.name
  });
}
```

### Add Custom Remediation

Edit [self-healing-system/agents/executor.js](self-healing-system/agents/executor.js):

```javascript
// Add custom fix strategy
if (rcaOutput.problem === 'custom_issue') {
  return this.executeCustomFix(rcaOutput.target);
}
```

---

## Key Files

| File | Purpose |
|------|---------|
| `start-with-live-metrics.js` | Main entry point for live metrics |
| `self-healing-system/main.js` | Core orchestration & validation loop |
| `self-healing-system/dashboard/app.js` | Frontend dashboard logic |
| `self-healing-system/dashboard/index.html` | Dashboard UI template |
| `self-healing-system/utils/metricsFetcher.js` | Fetches from ngrok endpoint |
| `self-healing-system/adapters/clusterStateAdapter.js` | Normalizes incoming data |
| `self-healing-system/agents/observer.js` | Detects issues |
| `self-healing-system/agents/detector.js` | Confirms issues |
| `self-healing-system/agents/rca.js` | Root cause analysis |
| `self-healing-system/agents/executor.js` | Executes fixes |

---

## Architecture

```
┌─────────────────────────────────────────┐
│          LIVE METRICS FLOW              │
├─────────────────────────────────────────┤
│                                          │
│  Ngrok Endpoint                         │
│  └─→ MetricsFetcher                     │
│      └─→ Adapter (Normalize)            │
│          └─→ ClusterState               │
│              └─→ Observer (Analyze)     │
│                  └─→ Detector (Confirm) │
│                      └─→ RCA (Analyze)  │
│                          └─→ Executor   │
│                              ↓          │
│                          Dashboard      │
│                          (Real-time UI) │
│                                          │
└─────────────────────────────────────────┘
```

---

## Performance Notes

- **Metrics Cache**: 5 seconds (prevents excessive API calls)
- **Max Retries**: 3 attempts to heal
- **Retry Delay**: 5 seconds between attempts
- **Memory Limit**: 1000 learned patterns (auto-cleanup with 7-day TTL)
- **Dependency Trace**: 5 levels deep

---

**Ready to use with live metrics! 🚀**

See version 1.0 - Self-Healing System with AI Agents
