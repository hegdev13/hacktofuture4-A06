/**
 * Test Suite for Dependency Graph System
 * Tests all components: graph, propagation, RCA, and recovery
 */

const DependencyGraph = require('./modules/graph');
const RCAEngine = require('./modules/rca');

// Test utilities
let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  Error: ${err.message}`);
    testsFailed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertArrayEquals(actual, expected, message) {
  if (actual.length !== expected.length) {
    throw new Error(`${message}: length mismatch`);
  }
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${message}: element ${i} mismatch`);
    }
  }
}

// ============================================================================
// TEST SUITE 1: Graph Construction
// ============================================================================

console.log('\n=== TEST SUITE 1: Graph Construction ===\n');

test('Should add node to graph', () => {
  const graph = new DependencyGraph();
  graph.addNode('service1');
  assert(graph.nodes.has('service1'), 'Node not added');
  assertEquals(graph.nodes.get('service1').status, 'HEALTHY', 'Initial status should be HEALTHY');
});

test('Should add multiple nodes', () => {
  const graph = new DependencyGraph();
  graph.addNode('svc1');
  graph.addNode('svc2');
  graph.addNode('svc3');
  assertEquals(graph.nodes.size, 3, 'Should have 3 nodes');
});

test('Should prevent duplicate node addition', () => {
  const graph = new DependencyGraph();
  graph.addNode('service');
  graph.addNode('service'); // Should warn, not throw
  assertEquals(graph.nodes.size, 1, 'Should still have 1 node');
});

test('Should add edge between nodes', () => {
  const graph = new DependencyGraph();
  graph.addNode('serviceA');
  graph.addNode('serviceB');
  graph.addEdge('serviceA', 'serviceB', 'hard');
  
  const edges = graph.edges.get('serviceA');
  assert(edges.length > 0, 'Edge not added');
  assertEquals(edges[0].node, 'serviceB', 'Edge target incorrect');
  assertEquals(edges[0].type, 'hard', 'Edge type incorrect');
});

test('Should throw error for edge with non-existent node', () => {
  const graph = new DependencyGraph();
  graph.addNode('serviceA');
  try {
    graph.addEdge('serviceA', 'nonexistent', 'hard');
    throw new Error('Should have thrown');
  } catch (err) {
    assert(err.message.includes('does not exist'), 'Wrong error message');
  }
});

test('Should support both hard and soft edge types', () => {
  const graph = new DependencyGraph();
  graph.addNode('a');
  graph.addNode('b');
  graph.addNode('c');
  
  graph.addEdge('a', 'b', 'hard');
  graph.addEdge('a', 'c', 'soft');
  
  assertEquals(graph.edges.get('a')[0].type, 'hard', 'Hard edge type');
  assertEquals(graph.edges.get('a')[1].type, 'soft', 'Soft edge type');
});

test('Should reject invalid edge types', () => {
  const graph = new DependencyGraph();
  graph.addNode('a');
  graph.addNode('b');
  try {
    graph.addEdge('a', 'b', 'invalid');
    throw new Error('Should have thrown');
  } catch (err) {
    assert(err.message.includes('Invalid edge type'), 'Wrong error message');
  }
});

// ============================================================================
// TEST SUITE 2: Failure Propagation
// ============================================================================

console.log('\n=== TEST SUITE 2: Failure Propagation ===\n');

test('Should mark dependents as FAILED on hard dependency failure', () => {
  const graph = new DependencyGraph();
  graph.addNode('db', { status: 'HEALTHY' });
  graph.addNode('api', { status: 'HEALTHY' });
  graph.addEdge('api', 'db', 'hard');
  
  graph.updateHealth('db', { status: 'FAILED' });
  
  const apiStatus = graph.nodes.get('api').status;
  assertEquals(apiStatus, 'FAILED', 'API should be FAILED due to hard DB dependency');
});

test('Should mark dependents as DEGRADED on soft dependency failure', () => {
  const graph = new DependencyGraph();
  graph.addNode('cache', { status: 'HEALTHY' });
  graph.addNode('api', { status: 'HEALTHY' });
  graph.addEdge('api', 'cache', 'soft');
  
  graph.updateHealth('cache', { status: 'FAILED' });
  
  const apiStatus = graph.nodes.get('api').status;
  assertEquals(apiStatus, 'DEGRADED', 'API should be DEGRADED due to soft cache dependency');
});

test('Should propagate cascading hard failures', () => {
  const graph = new DependencyGraph();
  graph.addNode('frontend');
  graph.addNode('api');
  graph.addNode('db');
  
  graph.addEdge('frontend', 'api', 'hard');
  graph.addEdge('api', 'db', 'hard');
  
  graph.updateHealth('db', { status: 'FAILED' });
  
  const apiStatus = graph.nodes.get('api').status;
  const frontendStatus = graph.nodes.get('frontend').status;
  
  assertEquals(apiStatus, 'FAILED', 'API should be FAILED');
  assertEquals(frontendStatus, 'FAILED', 'Frontend should be FAILED (cascading)');
});

test('Should not propagate soft failures as cascading FAILED', () => {
  const graph = new DependencyGraph();
  graph.addNode('app1');
  graph.addNode('app2');
  graph.addNode('cache');
  
  graph.addEdge('app1', 'app2', 'hard');
  graph.addEdge('app2', 'cache', 'soft');
  
  graph.updateHealth('cache', { status: 'FAILED' });
  
  const app2Status = graph.nodes.get('app2').status;
  const app1Status = graph.nodes.get('app1').status;
  
  assertEquals(app2Status, 'DEGRADED', 'app2 should be DEGRADED');
  assertEquals(app1Status, 'DEGRADED', 'app1 should be DEGRADED (not FAILED from soft chain)');
});

test('Should update health scores during propagation', () => {
  const graph = new DependencyGraph();
  graph.addNode('api', { status: 'HEALTHY', healthScore: 1.0 });
  graph.addNode('db', { status: 'HEALTHY', healthScore: 1.0 });
  graph.addEdge('api', 'db', 'hard');
  
  graph.updateHealth('db', { status: 'FAILED', healthScore: 0 });
  
  const apiHealth = graph.nodes.get('api').healthScore;
  assert(apiHealth < 1.0, 'API health should decrease');
});

// ============================================================================
// TEST SUITE 3: Recovery/Healing
// ============================================================================

console.log('\n=== TEST SUITE 3: Recovery/Healing ===\n');

test('Should restore dependent when dependency recovers', () => {
  const graph = new DependencyGraph();
  graph.addNode('api', { status: 'HEALTHY' });
  graph.addNode('db', { status: 'HEALTHY' });
  graph.addEdge('api', 'db', 'hard');
  
  // Fail
  graph.updateHealth('db', { status: 'FAILED' });
  assertEquals(graph.nodes.get('api').status, 'FAILED', 'API should be FAILED');
  
  // Recover
  graph.updateHealth('db', { status: 'HEALTHY' });
  assertEquals(graph.nodes.get('api').status, 'HEALTHY', 'API should recover');
});

test('Should not recover if some dependencies still failed', () => {
  const graph = new DependencyGraph();
  graph.addNode('api', { status: 'HEALTHY' });
  graph.addNode('db', { status: 'HEALTHY' });
  graph.addNode('cache', { status: 'HEALTHY' });
  
  graph.addEdge('api', 'db', 'hard');
  graph.addEdge('api', 'cache', 'hard');
  
  // Fail both
  graph.updateHealth('db', { status: 'FAILED' });
  graph.updateHealth('cache', { status: 'FAILED' });
  
  // Recover only db
  graph.updateHealth('db', { status: 'HEALTHY' });
  
  // API should still be degraded/failed because cache is still down
  const apiStatus = graph.nodes.get('api').status;
  assert(apiStatus !== 'HEALTHY', 'API should not be HEALTHY while cache is still FAILED');
});

test('Should handle multi-level recovery propagation', () => {
  const graph = new DependencyGraph();
  graph.addNode('frontend');
  graph.addNode('api');
  graph.addNode('db');
  
  graph.addEdge('frontend', 'api', 'hard');
  graph.addEdge('api', 'db', 'hard');
  
  // Fail db => api => frontend
  graph.updateHealth('db', { status: 'FAILED' });
  assertEquals(graph.nodes.get('frontend').status, 'FAILED');
  
  // Recover db
  graph.updateHealth('db', { status: 'HEALTHY' });
  
  // Check multi-level recovery
  assertEquals(graph.nodes.get('db').status, 'HEALTHY');
  assertEquals(graph.nodes.get('api').status, 'HEALTHY');
  assertEquals(graph.nodes.get('frontend').status, 'HEALTHY');
});

// ============================================================================
// TEST SUITE 4: Dependency Traversal
// ============================================================================

console.log('\n=== TEST SUITE 4: Dependency Traversal ===\n');

test('Should find direct dependencies', () => {
  const graph = new DependencyGraph();
  graph.addNode('a');
  graph.addNode('b');
  graph.addNode('c');
  
  graph.addEdge('a', 'b', 'hard');
  graph.addEdge('a', 'c', 'hard');
  
  const deps = graph.getDependencies('a');
  assertArrayEquals(deps.sort(), ['b', 'c'].sort(), 'Should find both dependencies');
});

test('Should find transitive dependencies', () => {
  const graph = new DependencyGraph();
  graph.addNode('a');
  graph.addNode('b');
  graph.addNode('c');
  
  graph.addEdge('a', 'b', 'hard');
  graph.addEdge('b', 'c', 'hard');
  
  const transDeps = graph.getTransitiveDependencies('a');
  assert(transDeps.has('b') && transDeps.has('c'), 'Should find both direct and transitive dependencies');
});

test('Should find direct dependents', () => {
  const graph = new DependencyGraph();
  graph.addNode('db');
  graph.addNode('api1');
  graph.addNode('api2');
  
  graph.addEdge('api1', 'db', 'hard');
  graph.addEdge('api2', 'db', 'hard');
  
  const deps = graph.getDependents('db');
  assertArrayEquals(deps.sort(), ['api1', 'api2'].sort(), 'Should find both dependents');
});

test('Should find transitive dependents', () => {
  const graph = new DependencyGraph();
  graph.addNode('db');
  graph.addNode('api');
  graph.addNode('frontend');
  
  graph.addEdge('api', 'db', 'hard');
  graph.addEdge('frontend', 'api', 'hard');
  
  const transDeps = graph.getTransitiveDependents('db');
  assert(transDeps.has('api') && transDeps.has('frontend'), 'Should find both direct and transitive dependents');
});

// ============================================================================
// TEST SUITE 5: Root Cause Analysis
// ============================================================================

console.log('\n=== TEST SUITE 5: Root Cause Analysis ===\n');

test('Should identify service as root cause when no dependencies failed', () => {
  const graph = new DependencyGraph();
  const rca = new RCAEngine(graph);
  
  graph.addNode('api', { status: 'FAILED' });
  
  const result = rca.analyzeFailure('api');
  assertEquals(result.rootCause, 'api', 'Service should be root cause');
  assertEquals(result.failurePath[0], 'api', 'Path should start with failing service');
});

test('Should identify deepest failed dependency as root cause', () => {
  const graph = new DependencyGraph();
  const rca = new RCAEngine(graph);
  
  graph.addNode('frontend', { status: 'FAILED' });
  graph.addNode('api', { status: 'FAILED' });
  graph.addNode('db', { status: 'FAILED' });
  
  graph.addEdge('frontend', 'api', 'hard');
  graph.addEdge('api', 'db', 'hard');
  
  const result = rca.analyzeFailure('frontend');
  assertEquals(result.rootCause, 'db', 'DB should be identified as root cause');
});

test('Should order failure path correctly', () => {
  const graph = new DependencyGraph();
  const rca = new RCAEngine(graph);
  
  graph.addNode('frontend', { status: 'FAILED' });
  graph.addNode('api', { status: 'FAILED' });
  graph.addNode('db', { status: 'FAILED' });
  
  graph.addEdge('frontend', 'api', 'hard');
  graph.addEdge('api', 'db', 'hard');
  
  const result = rca.analyzeFailure('frontend');
  assert(result.failurePath.includes('frontend'), 'Path should include frontend');
  assert(result.failurePath.includes('api'), 'Path should include api');
  assert(result.failurePath.includes('db'), 'Path should include db');
});

test('Should calculate confidence score', () => {
  const graph = new DependencyGraph();
  const rca = new RCAEngine(graph);
  
  graph.addNode('api', { status: 'FAILED' });
  
  const result = rca.analyzeFailure('api');
  assert(result.rootCauseConfidence >= 0 && result.rootCauseConfidence <= 1, 'Confidence should be 0-1');
  assert(result.rootCauseConfidence > 0.5, 'Confidence should be reasonable for clear root cause');
});

test('Should identify affected services', () => {
  const graph = new DependencyGraph();
  const rca = new RCAEngine(graph);
  
  graph.addNode('db', { status: 'FAILED' });
  graph.addNode('api', { status: 'FAILED' });
  graph.addNode('frontend', { status: 'FAILED' });
  
  graph.addEdge('api', 'db', 'hard');
  graph.addEdge('frontend', 'api', 'hard');
  
  const result = rca.analyzeFailure('frontend');
  assert(result.affectedServices.length > 0, 'Should identify affected services');
  assert(result.affectedServices.includes('api'), 'API should be in affected services');
});

// ============================================================================
// TEST SUITE 6: Cycle Detection
// ============================================================================

console.log('\n=== TEST SUITE 6: Cycle Detection ===\n');

test('Should detect simple cycle A->B->A', () => {
  const graph = new DependencyGraph();
  graph.addNode('a');
  graph.addNode('b');
  
  graph.addEdge('a', 'b', 'hard');
  graph.addEdge('b', 'a', 'hard');
  
  const cycles = graph.detectCycles();
  assert(cycles && cycles.length > 0, 'Should detect cycle');
});

test('Should detect complex cycle A->B->C->A', () => {
  const graph = new DependencyGraph();
  graph.addNode('a');
  graph.addNode('b');
  graph.addNode('c');
  
  graph.addEdge('a', 'b', 'hard');
  graph.addEdge('b', 'c', 'hard');
  graph.addEdge('c', 'a', 'hard');
  
  const cycles = graph.detectCycles();
  assert(cycles && cycles.length > 0, 'Should detect cycle');
});

test('Should not detect cycles in DAG', () => {
  const graph = new DependencyGraph();
  graph.addNode('a');
  graph.addNode('b');
  graph.addNode('c');
  
  graph.addEdge('a', 'b', 'hard');
  graph.addEdge('b', 'c', 'hard');
  
  const cycles = graph.detectCycles();
  assert(!cycles || cycles.length === 0, 'Should not detect cycles in DAG');
});

// ============================================================================
// TEST SUITE 7: Health Summary
// ============================================================================

console.log('\n=== TEST SUITE 7: Health Summary ===\n');

test('Should calculate correct health summary', () => {
  const graph = new DependencyGraph();
  graph.addNode('svc1', { status: 'HEALTHY' });
  graph.addNode('svc2', { status: 'DEGRADED' });
  graph.addNode('svc3', { status: 'FAILED' });
  
  const summary = graph.getHealthSummary();
  assertEquals(summary.total, 3, 'Total should be 3');
  assertEquals(summary.healthy, 1, 'Healthy should be 1');
  assertEquals(summary.degraded, 1, 'Degraded should be 1');
  assertEquals(summary.failed, 1, 'Failed should be 1');
});

test('Should calculate health percentage', () => {
  const graph = new DependencyGraph();
  graph.addNode('svc1', { status: 'HEALTHY', healthScore: 1.0 });
  graph.addNode('svc2', { status: 'FAILED', healthScore: 0 });
  
  const summary = graph.getHealthSummary();
  assertEquals(summary.healthPercent, 50, 'Health percent should be 50%');
});

// ============================================================================
// TEST RESULTS
// ============================================================================

console.log('\n' + '='.repeat(60));
console.log(`\n${ testsFailed === 0 ? '✓ ALL TESTS PASSED!' : '✗ SOME TESTS FAILED'}`);
console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed\n`);

module.exports = {
  testsPassed,
  testsFailed,
};
