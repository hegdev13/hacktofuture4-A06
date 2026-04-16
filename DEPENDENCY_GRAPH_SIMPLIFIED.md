# Dependency Graph Simplified - Pure Visualization

## What Changed

The dependency graph is now **pure visualization** - it shows ONLY:
1. ✅ Service relationships (which services depend on which)
2. ✅ Pod states (running/failed/pending)
3. ✅ State propagation through dependencies
4. ❌ NO root cause analysis
5. ❌ NO confidence scoring
6. ❌ NO remediation suggestions

## API Endpoint

**GET** `/api/dependencies/analyze?endpoint=<UUID>`

### Request
```bash
curl "http://localhost:3000/api/dependencies/analyze?endpoint=YOUR_UUID"
```

### Response
```json
{
  "ok": true,
  "analysis": {
    "graphPods": [
      {
        "id": "frontend",
        "name": "frontend",
        "status": "running|failed|pending",
        "dependsOn": ["api", "cache"],
        "healthScore": 95
      }
    ],
    "status": "healthy|degraded|critical",
    "healthPercent": 85,
    "summary": "All services healthy. Cluster health: 85%"
  }
}
```

**That's it!** Simple, focused, clean.

---

## Data Flow

```
Metrics from Supabase
       ↓
Extract service names from pod names
       ↓
Group pods by service
       ↓
Calculate health score for each service
       ↓
Build dependency map from labels (or patterns)
       ↓
Create graph nodes with status + dependencies
       ↓
Return graphPods array
```

---

## How Dependencies Are Extracted

### Priority Order
1. **Pod Labels** (first choice)
   ```yaml
   labels:
     app.kubernetes.io/depends-on: "database,redis"
   ```

2. **Pattern Matching** (fallback)
   - Frontend → APIs, services
   - API → databases, caches
   - Worker → queues, caches
   - etc.

---

## Node Structure

Each node in `graphPods` contains:
- `id`: Service identifier
- `name`: Service name
- `status`: Current state (running/failed/pending)
- `dependsOn`: List of service names this depends on
- `healthScore`: 0-100 health rating

**No more failureType, failureReason, root cause, or confidence!**

---

## Dashboard Display

### Health Cards
- Cluster Status (healthy/degraded/critical)
- Cluster Health % (0-100)
- Number of Services

### Summary
Simple text: "All services healthy" or "X service(s) in failed state"

### Graph Visualization
- Visual nodes for each service
- Edges showing dependencies
- Color coded by status (running=green, failed=red, pending=yellow)

### Dependency Tree
- Shows JSON tree of all pods and their relationships
- No analysis, just structure

---

## Status Summary

| Component | Before | After |
|-----------|--------|-------|
| RCA | ✓ Included | ❌ Removed |
| Root Cause Detection | ✓ Included | ❌ Removed |
| Cascading Failure ID | ✓ Included | ❌ Removed |
| Confidence Scoring | ✓ Included | ❌ Removed |
| Remediations | ✓ Included | ❌ Removed |
| Dependency Extraction | ✓ Same | ✓ Same |
| State Propagation | ✓ Same | ✓ Same |
| Health Calculation | ✓ Same | ✓ Same |

---

## Where RCA Goes

RCA (Root Cause Analysis) is now the job of the **RCA Agent** in `/ai_agents/rca-agent.js`.

The dependency graph just provides the clean data:
- Service relationships
- Current states
- Health metrics

The RCA agent can use this data to:
- Analyze patterns
- Identify root causes
- Suggest remediation
- Score confidence

---

## Code Locations

**API Route:** `/src/app/api/dependencies/analyze/route.ts`
- Simple, focused, ~70 lines
- No RCA logic
- Just graph building

**Dependency Builder:** `/src/lib/observability/dependency.ts`
- `buildDependencyImpact()` function
- Returns: graphPods, status, healthPercent, summary
- No analysis

**Page Component:** `/src/app/dashboard/dependency/page.tsx`
- Shows 3 health cards
- Displays summary
- Shows graph visualization
- Shows dependency tree
- No RCA sections

---

## Testing

### Test 1: Simple Dependency Graph
```bash
curl -s "http://localhost:3000/api/dependencies/analyze?endpoint=$UUID" | \
  jq '.analysis.graphPods | map({name, status, dependsOn})'
```

Expected output:
```json
[
  {
    "name": "frontend",
    "status": "running",
    "dependsOn": ["api", "cache"]
  },
  {
    "name": "api",
    "status": "running",
    "dependsOn": ["database"]
  }
]
```

### Test 2: Pod Failure
Mark a pod as failed, refresh graph:
- ✅ Pod shows status: "failed"
- ✅ Dependent pods show status: "pending" or "failed" (based on health)
- ✅ Summary updates
- ✅ NO root cause analysis
- ✅ NO cascading failure labels

---

## Benefits

✅ **Simpler Code** - No complex RCA logic in graph API
✅ **Faster Response** - Fewer calculations
✅ **Focused** - Does one thing well
✅ **Extensible** - RCA agent can layer analysis on top
✅ **Testable** - Easy to test graph structure independently
✅ **Maintainable** - Clear separation of concerns

---

## Future: RCA Integration

When RCA agent runs, it will:
1. Call `/api/dependencies/analyze` to get clean graph
2. Query other APIs for detailed metrics
3. Run analysis algorithms
4. Generate root cause + recommendations
5. Display in separate "RCA Analysis" panel

Dependency graph remains pure visualization, RCA becomes optional analysis layer.

---

**Status:** ✅ Complete
**Lines of Code:** ~70 API + ~140 dependency builder
**Dependencies:** None removed, simplified usage
**Breaking Changes:** None (output structure same, just fewer fields)
