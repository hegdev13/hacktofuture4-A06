/**
 * Comprehensive Example Scenario
 * Demonstrates dependency-aware failure propagation, RCA, and recovery
 * 
 * Scenario: Frontend → API → DB
 * Cases:
 * 1. DB failure (root cause) → API and Frontend degradation
 * 2. DB recovery → System restoration
 * 3. Cascading failure analysis
 * 4. Cycle detection and handling
 */

const DependencyGraph = require('./modules/graph');
const RCAEngine = require('./modules/rca');

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function section(title) {
  console.log(`\n${colors.bright}${colors.blue}${'='.repeat(80)}${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}${title}${colors.reset}`);
  console.log(`${colors.bright}${colors.blue}${'='.repeat(80)}${colors.reset}\n`);
}

function subsection(title) {
  console.log(`\n${colors.bright}${colors.yellow}► ${title}${colors.reset}`);
  console.log(`${colors.gray}${'-'.repeat(70)}${colors.reset}`);
}

function success(msg) {
  console.log(`${colors.green}✓ ${msg}${colors.reset}`);
}

function error(msg) {
  console.log(`${colors.red}✗ ${msg}${colors.reset}`);
}

function info(msg) {
  console.log(`${colors.cyan}ℹ ${msg}${colors.reset}`);
}

function logJson(obj, indent = 2) {
  console.log(JSON.stringify(obj, null, indent));
}

// ============================================================================
// EXAMPLE 1: Basic Setup - Frontend → API → DB
// ============================================================================

section('EXAMPLE 1: System Setup - Frontend → API → DB');

const graph = new DependencyGraph();
const rca = new RCAEngine(graph);

subsection('Step 1: Add nodes (services)');

// Add nodes with initial state
graph.addNode('frontend', {
  status: 'HEALTHY',
  healthScore: 1.0,
  errorRate: 0,
  restartCount: 0,
});

graph.addNode('api', {
  status: 'HEALTHY',
  healthScore: 1.0,
  errorRate: 0,
  restartCount: 0,
});

graph.addNode('db', {
  status: 'HEALTHY',
  healthScore: 1.0,
  errorRate: 0,
  restartCount: 0,
});

graph.addNode('cache', {
  status: 'HEALTHY',
  healthScore: 1.0,
  errorRate: 0,
  restartCount: 0,
});

success('Added 4 nodes: frontend, api, db, cache');

subsection('Step 2: Add dependency edges');

// Frontend depends on API (hard dependency)
graph.addEdge('frontend', 'api', 'hard', 1.0);
info('frontend → api (HARD dependency, weight=1.0)');

// API depends on DB (hard dependency)
graph.addEdge('api', 'db', 'hard', 1.0);
info('api → db (HARD dependency, weight=1.0)');

// API depends on cache (soft dependency)
graph.addEdge('api', 'cache', 'soft', 0.8);
info('api → cache (SOFT dependency, weight=0.8)');

success('Dependency graph established');

console.log('\n' + colors.gray + 'Graph structure:' + colors.reset);
console.log(`
  frontend
    ↓ (hard)
  api
    ├─→ db (hard)
    └─→ cache (soft)
`);

// ============================================================================
// EXAMPLE 2: Simulate DB Failure
// ============================================================================

section('EXAMPLE 2: Simulate DB Failure');

subsection('Step 3: DB fails (OOMKilled)');

graph.updateHealth('db', {
  status: 'FAILED',
  healthScore: 0,
  errorRate: 0.95,
  restartCount: 3,
});

info('DB status updated to FAILED');
info('DB health score: 0, error rate: 95%, restart count: 3');

subsection('Step 4: Check propagated states');

const dbInfo = graph.getNodeInfo('db');
const apiInfo = graph.getNodeInfo('api');
const frontendInfo = graph.getNodeInfo('frontend');
const cacheInfo = graph.getNodeInfo('cache');

console.log(`\n${colors.bright}Node States After DB Failure:${colors.reset}`);
console.log(`
  DB:       ${colors.red}${dbInfo.status}${colors.reset} (healthScore: ${dbInfo.healthScore})
  API:      ${colors.yellow}${apiInfo.status}${colors.reset} (healthScore: ${apiInfo.healthScore}) - hard dependency failed
  Frontend: ${colors.yellow}${frontendInfo.status}${colors.reset} (healthScore: ${frontendInfo.healthScore}) - API degraded
  Cache:    ${colors.green}${cacheInfo.status}${colors.reset} (healthScore: ${cacheInfo.healthScore}) - soft dependency, not direct impact
`);

if (dbInfo.status === 'FAILED') success('DB is FAILED');
if (apiInfo.status === 'FAILED' || apiInfo.status === 'DEGRADED') success('API is FAILED/DEGRADED due to hard DB dependency');
if (frontendInfo.status === 'FAILED' || frontendInfo.status === 'DEGRADED') success('Frontend is FAILED/DEGRADED due to API failure');

subsection('Step 5: Get health summary');

const summary = graph.getHealthSummary();
console.log(`
  Total Services:    ${summary.total}
  Healthy:           ${colors.green}${summary.healthy}${colors.reset}
  Degraded:          ${colors.yellow}${summary.degraded}${colors.reset}
  Failed:            ${colors.red}${summary.failed}${colors.reset}
  System Health:     ${summary.healthPercent}%
`);

// ============================================================================
// EXAMPLE 3: Root Cause Analysis
// ============================================================================

section('EXAMPLE 3: Root Cause Analysis');

subsection('Step 6: Analyze Frontend failure via RCA');

const frontendAnalysis = rca.analyzeFailure('frontend');

console.log(`\n${colors.bright}RCA Result for Frontend:${colors.reset}`);
console.log(colors.gray + frontendAnalysis.analysis.summary + colors.reset);

console.log(`\n${colors.bright}Detailed Analysis:${colors.reset}`);
console.log(`
  Root Cause:          ${colors.red}${frontendAnalysis.rootCause}${colors.reset}
  Failure Path:        ${frontendAnalysis.failurePath.join(' → ')}
  RCA Confidence:      ${Math.round(frontendAnalysis.rootCauseConfidence * 100)}%
  Affected Services:   ${frontendAnalysis.affectedServices.length}
  Failure Type:        ${frontendAnalysis.analysis.rootCauseType}
`);

subsection('Step 7: Analyze API failure via RCA');

const apiAnalysis = rca.analyzeFailure('api');

console.log(`\n${colors.bright}RCA Result for API:${colors.reset}`);
console.log(colors.gray + apiAnalysis.analysis.summary + colors.reset);

console.log(`\n${colors.bright}Detailed Analysis:${colors.reset}`);
console.log(`
  Root Cause:          ${colors.red}${apiAnalysis.rootCause}${colors.reset}
  Failure Path:        ${apiAnalysis.failurePath.join(' → ')}
  RCA Confidence:      ${Math.round(apiAnalysis.rootCauseConfidence * 100)}%
  Affected Services:   ${apiAnalysis.affectedServices.length}
`);

subsection('Step 8: Recommended remediation actions');

console.log(`\n${colors.bright}Top 3 Recommended Actions:${colors.reset}`);
apiAnalysis.analysis.recommendations.slice(0, 3).forEach((rec, idx) => {
  console.log(`\n  ${idx + 1}. [${colors.red}${rec.priority}${colors.reset}] ${rec.action}`);
  console.log(`     Reason: ${rec.reason}`);
  console.log(`     Command: ${colors.gray}${rec.command}${colors.reset}`);
  console.log(`     Impact: ${rec.impact}`);
});

// ============================================================================
// EXAMPLE 4: Impact Analysis
// ============================================================================

section('EXAMPLE 4: Impact Analysis');

subsection('Step 9: Analyze all failures');

const allFailures = rca.analyzeAllFailures();

console.log(`\n${colors.bright}Failure Summary:${colors.reset}`);
console.log(`
  Total Failed Services: ${allFailures.totalFailures}
  Primary Root Cause:    ${colors.red}${allFailures.primaryRootCause}${colors.reset}
`);

console.log(`\n${colors.bright}All Failures (by confidence):${colors.reset}`);
allFailures.results.forEach((failure, idx) => {
  console.log(`
  ${idx + 1}. ${failure.startNode}
     Root Cause: ${failure.rootCause}
     Confidence: ${Math.round(failure.rootCauseConfidence * 100)}%
     Impact: ${failure.affectedServices.length} downstream services
  `);
});

// ============================================================================
// EXAMPLE 5: Heal & Recovery
// ============================================================================

section('EXAMPLE 5: Healing & Recovery');

subsection('Step 10: DB recovers (health check passes)');

graph.updateHealth('db', {
  status: 'HEALTHY',
  healthScore: 1.0,
  errorRate: 0,
  restartCount: 3, // Restart count persists
});

info('DB status updated to HEALTHY');

subsection('Step 11: Check propagated recovery');

const dbInfoAfter = graph.getNodeInfo('db');
const apiInfoAfter = graph.getNodeInfo('api');
const frontendInfoAfter = graph.getNodeInfo('frontend');

console.log(`\n${colors.bright}Node States After DB Recovery:${colors.reset}`);
console.log(`
  DB:       ${colors.green}${dbInfoAfter.status}${colors.reset} (healthScore: ${dbInfoAfter.healthScore})
  API:      ${colors.green}${apiInfoAfter.status}${colors.reset} (healthScore: ${apiInfoAfter.healthScore}) - recovered
  Frontend: ${colors.green}${frontendInfoAfter.status}${colors.reset} (healthScore: ${frontendInfoAfter.healthScore}) - recovered
`);

if (apiInfoAfter.status === 'HEALTHY') success('API recovered when DB health restored');
if (frontendInfoAfter.status === 'HEALTHY') success('Frontend recovered when API health restored');

subsection('Step 12: Final system health');

const finalSummary = graph.getHealthSummary();
console.log(`
  Total Services:    ${finalSummary.total}
  Healthy:           ${colors.green}${finalSummary.healthy}${colors.reset}
  Degraded:          ${colors.yellow}${finalSummary.degraded}${colors.reset}
  Failed:            ${colors.red}${finalSummary.failed}${colors.reset}
  System Health:     ${finalSummary.healthPercent}%
`);

// ============================================================================
// EXAMPLE 6: Propagation Log Analysis
// ============================================================================

section('EXAMPLE 6: Debug - Propagation Log');

subsection('Step 13: View propagation steps');

const recentLog = graph.getPropagationLog(10);
console.log(`\n${colors.bright}Last 10 Propagation Events:${colors.reset}\n`);

recentLog.forEach((entry, idx) => {
  const icon =
    entry.action.includes('FAILED') ? '↓' :
    entry.action.includes('RECOVERY') ? '↑' :
    entry.action.includes('DEGRADATION') ? '⚠' : '•';

  console.log(`${colors.gray}[${entry.timestamp.slice(11, 19)}]${colors.reset} ${colors.cyan}${icon}${colors.reset} ${entry.action}`);
  if (Object.keys(entry.details).length > 0) {
    console.log(`   ${colors.gray}${JSON.stringify(entry.details)}${colors.reset}`);
  }
});

// ============================================================================
// EXAMPLE 7: Cycle Detection
// ============================================================================

section('EXAMPLE 7: Cycle Detection & Prevention');

subsection('Step 14: Create a graph with potential cycle');

const cycleGraph = new DependencyGraph();

cycleGraph.addNode('serviceA');
cycleGraph.addNode('serviceB');
cycleGraph.addNode('serviceC');

cycleGraph.addEdge('serviceA', 'serviceB', 'hard');
cycleGraph.addEdge('serviceB', 'serviceC', 'hard');
cycleGraph.addEdge('serviceC', 'serviceA', 'hard'); // Creates cycle

info('Added cycle: A → B → C → A');

const cycles = cycleGraph.detectCycles();
if (cycles) {
  console.log(`\n${colors.red}⚠ Cycle Detected:${colors.reset}`);
  cycles.forEach(cycle => {
    console.log(`  ${cycle.join(' → ')}`);
  });
  error('Cycles should be avoided in production deployments');
} else {
  success('No cycles detected');
}

// ============================================================================
// EXAMPLE 8: Complex Multi-Level Scenario
// ============================================================================

section('EXAMPLE 8: Complex Multi-Service Scenario');

subsection('Step 15: Build a realistic microservices architecture');

const complexGraph = new DependencyGraph();

// Add services
const services = [
  'load-balancer',
  'gateway',
  'auth-service',
  'user-service',
  'product-service',
  'order-service',
  'payment-service',
  'postgres-db',
  'redis-cache',
];

services.forEach(svc => {
  complexGraph.addNode(svc, {
    status: 'HEALTHY',
    healthScore: 1.0,
    errorRate: 0,
    restartCount: 0,
  });
});

success(`Added ${services.length} services`);

subsection('Step 16: Define dependencies');

// Define the dependency graph
const dependencies = [
  // Frontend layer
  ['load-balancer', 'gateway', 'hard', 1.0],
  // API layer
  ['gateway', 'auth-service', 'hard', 1.0],
  ['gateway', 'user-service', 'hard', 1.0],
  ['gateway', 'product-service', 'hard', 1.0],
  ['gateway', 'order-service', 'hard', 1.0],
  // Service dependencies
  ['auth-service', 'postgres-db', 'hard', 1.0],
  ['user-service', 'postgres-db', 'hard', 1.0],
  ['product-service', 'postgres-db', 'hard', 1.0],
  ['product-service', 'redis-cache', 'soft', 0.7],
  ['order-service', 'postgres-db', 'hard', 1.0],
  ['order-service', 'payment-service', 'hard', 1.0],
  ['payment-service', 'redis-cache', 'soft', 0.8],
];

dependencies.forEach(([from, to, type, weight]) => {
  complexGraph.addEdge(from, to, type, weight);
  console.log(`  ${from} ${type === 'hard' ? '═>' : '- '} ${to} (weight: ${weight})`);
});

subsection('Step 17: Simulate postgres-db failure');

complexGraph.updateHealth('postgres-db', {
  status: 'FAILED',
  healthScore: 0,
  errorRate: 1.0,
  restartCount: 5,
});

info('postgres-db is now FAILED');

const complexSummary = complexGraph.getHealthSummary();
console.log(`\n${colors.bright}System Impact:${colors.reset}`);
console.log(`
  Healthy:   ${colors.green}${complexSummary.healthy}${colors.reset}
  Degraded:  ${colors.yellow}${complexSummary.degraded}${colors.reset}
  Failed:    ${colors.red}${complexSummary.failed}${colors.reset}
  Total:     ${complexSummary.total}
  Health %:  ${complexSummary.healthPercent}%
`);

subsection('Step 18: RCA for load-balancer failure');

const complexRCA = new RCAEngine(complexGraph);
const lbAnalysis = complexRCA.analyzeFailure('load-balancer');

console.log(`\n${colors.bright}RCA Result:${colors.reset}`);
console.log(`
  Failing Service:    load-balancer
  Root Cause:         ${colors.red}${lbAnalysis.rootCause}${colors.reset}
  Confidence:         ${Math.round(lbAnalysis.rootCauseConfidence * 100)}%
  Failure Chain:      ${lbAnalysis.failurePath.join(' ← ')}
  Affected Services:  ${lbAnalysis.affectedServices.length}
`);

// ============================================================================
// FINAL SUMMARY
// ============================================================================

section('TEST SUMMARY');

console.log(`${colors.bright}✓ All examples completed successfully!${colors.reset}\n`);

console.log(`${colors.bright}Key Takeaways:${colors.reset}`);
console.log(`
  1. Directed graphs enable accurate failure propagation modeling
  
  2. Hard dependencies cause cascading failures
     - When DB fails, API MUST fail, Frontend MUST fail
  
  3. Soft dependencies cause graceful degradation
     - When cache fails, services become DEGRADED, not FAILED
  
  4. Root cause analysis identifies the deepest failed dependency
     - Not just the first failing service
     - Uses multi-signal scoring for confidence
  
  5. Recovery must propagate upward intelligently
     - Services only recover when ALL dependencies are HEALTHY
     - Prevents premature recovery and cascading re-failures
  
  6. Cycle detection prevents infinite loops
     - Important for validation before propagation
  
  7. Complex architectures require careful dependency modeling
     - Multi-tier architectures benefit most from this system
`);

console.log(`\n${colors.gray}For production use, integrate with:${colors.reset}`);
console.log(`  - Kubernetes API for pod lifecycle events
  - Prometheus/Grafana for metrics
  - Alert managers for incident response
  - Observability stack for tracing\n`);

// Export modules for external use
module.exports = {
  DependencyGraph,
  RCAEngine,
};
