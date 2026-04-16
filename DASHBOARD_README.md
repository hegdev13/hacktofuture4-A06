# SRE Decision Studio - Dashboard Deployment Guide

## Quick Start

To start the dashboard with live metrics and pod visibility, run:

```bash
npm run start:all
```

Or directly:

```bash
node start-dashboard.js
```

## What Gets Started

1. **Mock Metrics Server** (`http://localhost:5555`)
   - Simulates a Kubernetes cluster
   - Provides live pod, node, and metrics data
   - Auto-cycles through different failure scenarios every 5 seconds

2. **Dashboard Web UI** (`http://localhost:3000`)
   - SRE Decision Pipeline tab: Simulate incident analysis
   - Live Metrics & Pods tab: Real-time cluster observability

## Features

### SRE Decision Pipeline
- Input incident JSON (logs, metrics, traces)
- Run through 4-step pipeline: Observer → Root Cause → Decider → Execution
- Get confidence scores and recommended actions

### Live Metrics & Pods Dashboard
- **Cluster Overview**: Total nodes, pods, running/failed counts
- **Resource Usage**: CPU, Memory, Storage bars with color-coded health
- **Nodes View**: Each node with CPU/memory utilization
- **Pods & Containers**: Live pod status with filtering
- **Active Alerts**: Real-time alerts from the cluster

## Troubleshooting

### Port Already in Use
If port 5555 or 3000 is in use, kill existing processes:
```bash
lsof -ti:5555 | xargs kill -9
lsof -ti:3000 | xargs kill -9
```

### CORS Issues
The mock server includes CORS headers. If you see CORS errors:
1. Ensure the mock server is running on port 5555
2. Check browser console for connection errors

### Dashboard Not Loading
1. Verify `index.html` exists in the project root
2. Check that `app.js` and `styles.css` are present
3. Try accessing directly: `http://localhost:3000/index.html`

## Architecture

```
┌─────────────────┐     HTTP      ┌──────────────────┐
│  Dashboard UI   │ ◄──────────── │  Mock Metrics    │
│  (Port 3000)    │               │  Server (5555)   │
└─────────────────┘               └──────────────────┘
        │                                   │
        │ Fetch /api/metrics                │ Simulate K8s
        ▼                                   ▼
┌─────────────────┐               ┌──────────────────┐
│  Metrics Tab    │               │  Dynamic Pod     │
│  - Pods list    │               │  - 6 sample pods │
│  - Node status  │               │  - 4 scenarios   │
│  - Alerts       │               │  - Health data   │
└─────────────────┘               └──────────────────┘
```

## Next Steps

To connect to a real Kubernetes cluster:
1. Replace the mock metrics server with actual K8s API calls
2. Use `kubectl proxy` or a metrics exporter like Prometheus
3. Update the `metricsUrl` in `app.js` to point to your cluster

Enjoy monitoring your cluster! 🚀
