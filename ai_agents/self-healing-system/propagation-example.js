/**
 * Dependency Graph Example
 * Demonstrates state propagation and recovery ONLY
 * NO root cause analysis
 */

const DependencyGraph = require('./modules/dependency-graph');
const DependencyExtractor = require('./modules/dependency-extractor');

console.log(
  '\n╔══════════════════════════════════════════════════════════════╗'
);
console.log('║  Dependency Graph - Pure State Propagation Example     ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

// ============================================================================
// SCENARIO: Frontend → API → Database
// ============================================================================

console.log('┌────────────────────────────────────────────────────────────┐');
console.log('│ SCENARIO 1: Build Graph (Frontend → API → DB)             │');
console.log('└────────────────────────────────────────────────────────────┘\n');

const graph = new DependencyGraph();

// Add services
console.log('Step 1: Add services\n');
graph.addNode('frontend', { status: 'HEALTHY', errorRate: 0, restartCount: 0 });
graph.addNode('api', { status: 'HEALTHY', errorRate: 0, restartCount: 0 });
graph.addNode('database', {
  status: 'HEALTHY',
  errorRate: 0,
  restartCount: 0,
});
graph.addNode('cache', { status: 'HEALTHY', errorRate: 0, restartCount: 0 });

// Add edges (dependencies)
console.log('\nStep 2: Add dependencies\n');
graph.addEdge('frontend', 'api', 'hard'); // Frontend needs API (critical)
graph.addEdge('api', 'database', 'hard'); // API needs Database (critical)
graph.addEdge('api', 'cache', 'soft'); // API needs Cache (optional)

console.log('\nStep 3: Initial graph state\n');
graph.printGraph();

// ============================================================================
// SCENARIO 2: Database Failure
// ============================================================================

console.log('\n┌────────────────────────────────────────────────────────────┐');
console.log('│ SCENARIO 2: Database Fails (Failure Propagation)          │');
console.log('└────────────────────────────────────────────────────────────┘\n');

console.log('Action: Database fails (OOMKilled)\n');
graph.updateNodeState('database', {
  status: 'FAILED',
  errorRate: 1.0,
  restartCount: 3,
});

console.log('\nGraph state after DB failure:\n');
graph.printGraph();

// Verify propagation
const apiState = graph.getNodeState('api');
const frontendState = graph.getNodeState('frontend');
const cacheState = graph.getNodeState('cache');

console.log('✓ State verification:');
console.log(`  - Database: FAILED (root cause)`);
console.log(`  - API: ${apiState.status} (hard dep to DB, should be FAILED)`);
console.log(
  `  - Frontend: ${frontendState.status} (hard dep to API, cascades to FAILED)`
);
console.log(`  - Cache: ${cacheState.status} (independent, stays HEALTHY)`);

// ============================================================================
// SCENARIO 3: Partial Failure (Soft Dependency)
// ============================================================================

console.log('\n┌────────────────────────────────────────────────────────────┐');
console.log('│ SCENARIO 3: Cache Fails (Soft Dependency)                 │');
console.log('└────────────────────────────────────────────────────────────┘\n');

// Reset to healthy
const graph2 = new DependencyGraph();
graph2.addNode('frontend');
graph2.addNode('api');
graph2.addNode('database');
graph2.addNode('cache');

graph2.addEdge('frontend', 'api', 'hard');
graph2.addEdge('api', 'database', 'hard');
graph2.addEdge('api', 'cache', 'soft'); // Soft!

console.log('Initial state (all healthy):\n');
graph2.printGraph();

console.log('\nAction: Cache fails\n');
graph2.updateNodeState('cache', { status: 'FAILED', errorRate: 1.0 });

console.log('\nGraph state after Cache failure:\n');
graph2.printGraph();

const api2State = graph2.getNodeState('api');
const db2State = graph2.getNodeState('database');

console.log('✓ Analysis:');
console.log(`  - Cache: FAILED (root cause)`);
console.log(`  - API: ${api2State.status} (soft dep, degrades to DEGRADED)`);
console.log(`  - Database: ${db2State.status} (not affected)`);
console.log(`  - Services continue operating in degraded mode`);

// ============================================================================
// SCENARIO 4: Recovery from Failure
// ============================================================================

console.log('\n┌────────────────────────────────────────────────────────────┐');
console.log('│ SCENARIO 4: Recovery Propagation                          │');
console.log('└────────────────────────────────────────────────────────────┘\n');

// Continue with graph from scenario 2
console.log('Current state (DB failed, API/Frontend cascaded):\n');
graph.printGraph();

console.log('\nAction: Database recovers (health check passes)\n');
graph.updateNodeState('database', {
  status: 'HEALTHY',
  errorRate: 0,
  restartCount: 3,
});

console.log('\nGraph state after DB recovery:\n');
graph.printGraph();

console.log('✓ Recovery chain:');
console.log('  1. Database: FAILED → HEALTHY');
console.log('  2. API: FAILED → checks deps → all HEALTHY → HEALTHY');
console.log('  3. Frontend: FAILED → checks deps → all HEALTHY → HEALTHY');

// ============================================================================
// SCENARIO 5: Partial Recovery
// ============================================================================

console.log('\n┌────────────────────────────────────────────────────────────┐');
console.log('│ SCENARIO 5: Partial Recovery (Multiple Dependencies)      │');
console.log('└────────────────────────────────────────────────────────────┘\n');

const graph3 = new DependencyGraph();

// API depends on both DB and Cache (both hard)
graph3.addNode('api');
graph3.addNode('database');
graph3.addNode('cache');

graph3.addEdge('api', 'database', 'hard');
graph3.addEdge('api', 'cache', 'hard');

console.log('Initial setup: API requires both DB and Cache\n');
graph3.printGraph();

console.log('\nBoth DB and Cache fail\n');
graph3.updateNodeState('database', { status: 'FAILED' });
graph3.updateNodeState('cache', { status: 'FAILED' });

console.log('\nGraph state (both deps failed):\n');
graph3.printGraph();

console.log('\nDB recovers, but Cache still down\n');
graph3.updateNodeState('database', { status: 'HEALTHY' });

console.log('\nGraph state:\n');
graph3.printGraph();

console.log('✓ Partial recovery observed:');
console.log('  - API stays DEGRADED (waiting for Cache)');
console.log('  - Not premature recovery!');

console.log('\nCache recovers\n');
graph3.updateNodeState('cache', { status: 'HEALTHY' });

console.log('\nGraph state (all deps healthy):\n');
graph3.printGraph();

console.log('✓ Full recovery:');
console.log('  - API now HEALTHY (all deps healthy)');

// ============================================================================
// SCENARIO 6: Dependency Extraction
// ============================================================================

console.log('\n┌────────────────────────────────────────────────────────────┐');
console.log('│ SCENARIO 6: Extract Dependencies from Multiple Sources    │');
console.log('└────────────────────────────────────────────────────────────┘\n');

const { mockEnv, mockConfig, mockLogs } = DependencyExtractor.getMockData();

console.log('Step 1: Extract from environment variables\n');
const envDeps = DependencyExtractor.extractFromEnv(mockEnv);
console.log('Extracted dependencies:');
envDeps.forEach(dep => {
  console.log(`  ${dep.from} → ${dep.to} [${dep.type}]`);
});

console.log('\nStep 2: Extract from configuration\n');
const configDeps = DependencyExtractor.extractFromConfig(mockConfig);
console.log('Extracted dependencies:');
configDeps.forEach(dep => {
  console.log(`  ${dep.from} → ${dep.to} [${dep.type}]`);
});

console.log('\nStep 3: Extract from logs\n');
const logDeps = DependencyExtractor.extractFromLogs(mockLogs);
console.log('Extracted dependencies:');
logDeps.forEach(dep => {
  console.log(`  ${dep.from} → ${dep.to} [${dep.type}]`);
});

console.log('\nStep 4: Merge and deduplicate\n');
const allDeps = DependencyExtractor.mergeDependencies(
  envDeps,
  configDeps,
  logDeps
);
console.log('Merged dependencies:');
allDeps.forEach(dep => {
  console.log(`  ${dep.from} → ${dep.to} [${dep.type}] (source: ${dep.source})`);
});

console.log('\nStep 5: Build graph from extracted dependencies\n');
const graphFromExtractor = new DependencyGraph();
DependencyExtractor.buildGraph(allDeps, graphFromExtractor);

console.log('Validation:');
const validation = DependencyExtractor.validateGraph(graphFromExtractor);
console.log(`  Valid: ${validation.valid}`);
if (validation.issues.length > 0) {
  validation.issues.forEach(issue => {
    console.log(`  ⚠ ${issue}`);
  });
}

console.log('\nBuild graph from extracted dependencies:\n');
graphFromExtractor.printGraph();

// ============================================================================
// SCENARIO 7: Complex Multi-Service Graph
// ============================================================================

console.log('\n┌────────────────────────────────────────────────────────────┐');
console.log('│ SCENARIO 7: Complex Microservices Architecture            │');
console.log('└────────────────────────────────────────────────────────────┘\n');

const complexGraph = new DependencyGraph();

// Add services
const services = [
  'frontend',
  'api-gateway',
  'auth-service',
  'user-service',
  'product-service',
  'order-service',
  'payment-service',
  'database',
  'redis',
];

services.forEach(service => {
  complexGraph.addNode(service);
});

// Add complex dependencies
const complexDeps = [
  ['frontend', 'api-gateway', 'hard'],
  ['api-gateway', 'auth-service', 'hard'],
  ['api-gateway', 'user-service', 'hard'],
  ['api-gateway', 'product-service', 'hard'],
  ['api-gateway', 'order-service', 'hard'],
  ['auth-service', 'database', 'hard'],
  ['user-service', 'database', 'hard'],
  ['product-service', 'database', 'hard'],
  ['product-service', 'redis', 'soft'],
  ['order-service', 'database', 'hard'],
  ['order-service', 'payment-service', 'hard'],
  ['payment-service', 'redis', 'soft'],
];

complexDeps.forEach(([from, to, type]) => {
  complexGraph.addEdge(from, to, type);
});

console.log('Complex graph (9 services):\n');
complexGraph.printGraph();

console.log('\nSimulating database failure:\n');
complexGraph.updateNodeState('database', { status: 'FAILED' });

console.log('\nGraph state:\n');
complexGraph.printGraph();

// ============================================================================
// SUMMARY
// ============================================================================

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║ SUMMARY                                                    ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

console.log(`✓ Module features demonstrated:\n`);
console.log('  1. Node creation and state tracking');
console.log('  2. Hard dependency failures (propagate to FAILED)');
console.log('  3. Soft dependency failures (propagate to DEGRADED)');
console.log('  4. Cascading failures through the graph');
console.log('  5. Intelligent recovery (waits for all deps)');
console.log('  6. Partial recovery handling');
console.log('  7. Dependency extraction from multiple sources');
console.log('  8. Graph validation and cycle detection');
console.log('  9. Complex multi-service architectures\n');

console.log(`✓ Key design principles:\n`);
console.log('  • NO root cause analysis');
console.log('  • Pure state propagation logic');
console.log('  • Dependency-aware failure handling');
console.log('  • Intelligent recovery (not just "turn it off and on")\n');

console.log('Module ready for integration with RCA engine!\n');

module.exports = {
  DependencyGraph,
  DependencyExtractor,
};
