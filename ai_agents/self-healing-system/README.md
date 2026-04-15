# Agentic Kubernetes Self-Healing System

A production-ready, modular self-healing system for Kubernetes that uses intelligent agents to detect anomalies, perform root cause analysis, and automatically remediate issues.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    SELF-HEALING SYSTEM                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────────────┐     │
│  │  OBSERVER   │──▶│    RCA      │──▶│   EXECUTIONER     │     │
│  │   AGENT     │   │    AGENT    │   │     AGENT         │     │
│  └─────────────┘   └─────────────┘   └─────────────────────┘     │
│         │                 │                   │                  │
│         ▼                 ▼                   ▼                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              MEMORY MODULE (Learning)                    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │           CLUSTER STATE ADAPTER (Flexible Input)         │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Observer Agent (`agents/observer.js`)
- **Purpose**: Detect anomalies in cluster state
- **Capabilities**:
  - Dynamic anomaly detection (no hardcoded rules)
  - Resource usage monitoring (CPU, memory, restarts)
  - Log analysis for error patterns
  - Dependency health checking
  - Cascading failure detection
- **Output**: JSON with health status and detected issues

### 2. RCA Agent (`agents/rca.js`)
- **Purpose**: Root Cause Analysis using dependency graphs
- **Capabilities**:
  - Dynamic dependency graph building from env/labels
  - Failure chain tracing (up to 5 levels deep)
  - Implicit relationship inference
  - Confidence scoring
- **Output**: JSON with root cause, failure chain, and reasoning

### 3. Executioner Agent (`agents/executor.js`)
- **Purpose**: Execute fixes based on RCA output
- **Capabilities**:
  - Multiple fix strategies (restart, scale, rollback)
  - Dependency-first fix ordering
  - Abstraction layer for K8s operations
  - Dry-run mode for safe testing
- **Output**: JSON with fix status and execution details

### 4. Memory Module (`agents/memory.js`)
- **Purpose**: Learn from past fixes
- **Capabilities**:
  - In-memory storage (no DB required)
  - Pattern matching for similar issues
  - Fix recommendation based on history
  - Confidence scoring
  - TTL-based cleanup

### 5. Cluster State Adapter (`adapters/clusterStateAdapter.js`)
- **Purpose**: Normalize any input format
- **Capabilities**:
  - Handles missing fields
  - Accepts additional/unknown fields
  - Dependency extraction from env/labels
  - Safe defaults

## Installation

```bash
cd self-healing-system
npm install
```

## Quick Start

### Run with Mock Data (Dry Run)
```bash
npm start
# or
node main.js
```

### Run with Real Kubernetes
```bash
# Set up your K8s credentials first
export KUBECONFIG=/path/to/kubeconfig
export DRY_RUN=false

npm run real
```

## Usage

### Basic Usage
```javascript
const system = require('./main');

// Run the self-healing system
const result = await system.runSelfHealingSystem();
console.log(result);
```

### Configuration
Edit `config/index.js` to customize:
- Severity thresholds
- RCA depth limits
- Execution strategies
- Memory settings

### Environment Variables
```bash
DRY_RUN=true              # Simulate actions without executing
KUBECONFIG=/path/to/config  # Path to kubeconfig
LOG_LEVEL=debug           # debug, info, warn, error
USE_MOCK_DATA=true        # Use mock data instead of real K8s
GEMINI_API_KEY=your_key   # Gemini API key for knowledge base guidance
GEMINI_MODEL=gemini-1.5-flash
KB_ENABLED=true           # Enable/disable external KB
KB_MIN_CONFIDENCE=70      # Min confidence to apply KB strategy
```

## Gemini Knowledge Base (Auto Guidance)

The execution agent can query Gemini as an external knowledge base before finalizing remediation.

- It receives RCA context (root cause, failure chain, affected resources)
- It suggests one safe strategy (`restart_pod`, `scale_up`, etc.)
- Strategy is applied only if confidence is above `KB_MIN_CONFIDENCE`
- Local heuristics remain as fallback when Gemini is unavailable

## Input Format

The system accepts flexible cluster state input:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "source": "kubernetes",
  "pods": [
    {
      "name": "api-server-7d9f4b8c5-x2z9a",
      "namespace": "default",
      "status": "Running",
      "phase": "Running",
      "cpu": 45,
      "memory": 60,
      "restarts": 0,
      "ready": true,
      "labels": {
        "app": "api-server",
        "tier": "backend"
      },
      "env": {
        "DB_HOST": "postgres.default.svc",
        "REDIS_URL": "redis.default.svc"
      },
      "logs": []
    }
  ],
  "nodes": [],
  "services": [],
  "metrics": {},
  "logs": [],
  "events": []
}
```

## Output Format

### Observer Output
```json
{
  "healthy": false,
  "issues": [
    {
      "pod": "api-server-7d9f4b8c5-x2z9a",
      "type": "high_cpu",
      "problem": "Critical CPU usage: 97%",
      "severity": "high",
      "metric": "cpu"
    }
  ],
  "summary": {
    "total": 1,
    "high": 1,
    "medium": 0,
    "low": 0
  }
}
```

### RCA Output
```json
{
  "rootCause": "api-server-7d9f4b8c5-x2z9a",
  "failureChain": [
    "Critical CPU usage: 97%"
  ],
  "confidence": 85,
  "reasoning": "Detected issue: Critical CPU usage..."
}
```

### Execution Output
```json
{
  "fixType": "scale_up",
  "target": "api-server",
  "namespace": "default",
  "replicas": 2,
  "status": "success",
  "message": "[DRY RUN] Scaling deployment..."
}
```

## Validation Loop

The system follows this loop:

```
Analyze → RCA → Fix → Re-check
   ↑                    │
   └────────────────────┘ (max 3 retries)
```

1. **Analyze**: Observer detects issues
2. **RCA**: Root cause analysis traces dependencies
3. **Fix**: Executioner applies remediation
4. **Re-check**: System health validated

## Mock Scenarios

The system includes 5 test scenarios:

1. **Healthy**: All systems operational
2. **High CPU**: API server at 97% CPU
3. **Crash Loop**: Pod in CrashLoopBackOff
4. **Dependency Failure**: Database connection issues
5. **Cascading Failure**: Multiple services affected

## Project Structure

```
self-healing-system/
├── agents/
│   ├── observer.js       # Anomaly detection
│   ├── rca.js           # Root cause analysis
│   ├── executor.js      # Fix execution
│   └── memory.js        # Learning module
├── adapters/
│   └── clusterStateAdapter.js  # Input normalization
├── config/
│   └── index.js         # Configuration
├── utils/
│   └── logger.js        # Timeline logging
├── main.js              # Main orchestrator
├── package.json
└── README.md
```

## Extending the System

### Add a New Fix Strategy
```javascript
// In executor.js
case 'my_custom_fix':
  result = this.executeCustomFix(strategy.target, strategy.namespace);
  break;
```

### Integrate Real Kubernetes
```javascript
// In main.js getClusterState()
async getClusterState() {
  // Replace with real K8s API calls
  const { KubeConfig, CoreV1Api } = require('@kubernetes/client-node');
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const k8sApi = kc.makeApiClient(CoreV1Api);
  
  const pods = await k8sApi.listNamespacedPod('default');
  return this.normalizeState(pods.body);
}
```

### Connect to Prometheus
```javascript
// Fetch metrics from Prometheus
async fetchPrometheusMetrics() {
  const response = await fetch('http://prometheus:9090/api/v1/query?query=up');
  const data = await response.json();
  return data.data.result;
}
```

## Timeline Logging

The system produces detailed timeline logs:

```
[10:30:01] [ANALYSIS] Starting cluster health analysis
[10:30:02] [ISSUE]    1 issue(s) detected
[10:30:02] [RCA]      Starting RCA for 1 issue(s)
[10:30:03] [RCA]      RCA completed
[10:30:03] [FIX]      Planning fix for api-server-7d9f4b8c5-x2z9a
[10:30:04] [SUCCESS]  Fix execution success
[10:30:05] [ANALYSIS] Re-checking system health...
[10:30:06] [SUCCESS]  System is healthy
```

## License

MIT

## Contributing

Pull requests welcome. Please ensure:
- No hardcoded service names
- JSON communication between agents
- Backward compatibility with adapter
- Tests for new features
