/**
 * Unit Tests for Dependency Graph Engine
 * Quick verification that all components work correctly
 */

const DependencyGraphEngine = require("./engine");
const DependencyGraph = require("./graph");
const { HealthMonitor, HealthState } = require("./health");
const { mockPods } = require("./mock-data");

let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
    passedTests++;
  } else {
    console.log(`✗ ${message}`);
    failedTests++;
  }
}

function assertEquals(actual, expected, message) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`✓ ${message}`);
    passedTests++;
  } else {
    console.log(`✗ ${message}`);
    console.log(`  Expected: ${JSON.stringify(expected)}`);
    console.log(`  Got: ${JSON.stringify(actual)}`);
    failedTests++;
  }
}

// ============================================================================
// TEST 1: Graph Construction
// ============================================================================
function testGraphConstruction() {
  console.log("\n📝 TEST 1: Graph Construction\n");

  const graph = new DependencyGraph();

  // Add nodes
  graph.addNode("frontend", "Frontend App");
  graph.addNode("api", "API Server");
  graph.addNode("db", "Database");

  assert(graph.nodes.size === 3, "Three nodes added");

  // Add edges
  const edge1 = graph.addEdge("frontend", "api");
  const edge2 = graph.addEdge("api", "db");

  assert(edge1 === true, "Edge frontend→api added");
  assert(edge2 === true, "Edge api→db added");
  assert(graph.edges.size === 2, "Two edges added");

  // Test dependencies
  const frontendDeps = graph.getDependencies("frontend");
  assertEquals(frontendDeps, ["api"], "Frontend depends on API");

  const apiDeps = graph.getDependencies("api");
  assertEquals(apiDeps, ["db"], "API depends on DB");
}

// ============================================================================
// TEST 2: Cycle Detection
// ============================================================================
function testCycleDetection() {
  console.log("\n🔄 TEST 2: Cycle Detection\n");

  const graph = new DependencyGraph();
  graph.addNode("a");
  graph.addNode("b");
  graph.addNode("c");

  graph.addEdge("a", "b");
  graph.addEdge("b", "c");

  // Try to create cycle: c→a
  const cycleAttempt = graph.addEdge("c", "a");

  assert(cycleAttempt === false, "Cycle c→a rejected");
  assert(graph.edges.size === 2, "No cycle created - only 2 edges");
}

// ============================================================================
// TEST 3: Transitive Dependencies
// ============================================================================
function testTransitiveDependencies() {
  console.log("\n🔗 TEST 3: Transitive Dependencies\n");

  const graph = new DependencyGraph();

  ["frontend", "api", "cache", "db"].forEach((n) => graph.addNode(n, n));

  graph.addEdge("frontend", "api");
  graph.addEdge("api", "cache");
  graph.addEdge("api", "db");
  graph.addEdge("cache", "db");

  const frontendTransDeps = graph.getTransitiveDependencies("frontend");

  assert(
    frontendTransDeps.includes("api"),
    "Frontend transitively depends on API"
  );
  assert(
    frontendTransDeps.includes("cache"),
    "Frontend transitively depends on Cache"
  );
  assert(
    frontendTransDeps.includes("db"),
    "Frontend transitively depends on DB"
  );
}

// ============================================================================
// TEST 4: Health Scoring
// ============================================================================
function testHealthScoring() {
  console.log("\n❤️ TEST 4: Health Scoring\n");

  const health = new HealthMonitor();

  // Healthy pod
  const healthyScore = health.computeHealthScore({
    restartCount: 0,
    errorRate: 0,
    podStatus: "Running",
    responseTime: 100,
  });

  assert(healthyScore >= 0.9, "Healthy pod has high score (>= 0.9)");

  // Failed pod
  const failedScore = health.computeHealthScore({
    restartCount: 10,
    errorRate: 1.0,
    podStatus: "CrashLoopBackOff",
  });

  assert(failedScore <= 0.2, "Failed pod has low score (<= 0.2)");

  // State determination
  const healthyState = health.getState(0.95);
  assertEquals(healthyState, HealthState.HEALTHY, "Score 0.95 = HEALTHY");

  const degradedState = health.getState(0.35);
  assertEquals(degradedState, HealthState.DEGRADED, "Score 0.35 = DEGRADED");

  const failedState = health.getState(0.15);
  assertEquals(failedState, HealthState.FAILED, "Score 0.15 = FAILED");
}

// ============================================================================
// TEST 5: Health Propagation
// ============================================================================
function testHealthPropagation() {
  console.log("\n📢 TEST 5: Health Propagation\n");

  const graph = new DependencyGraph();
  const health = new HealthMonitor();

  ["frontend", "api", "db"].forEach((n) => graph.addNode(n, n));
  graph.addEdge("frontend", "api");
  graph.addEdge("api", "db");

  // Initialize all as healthy
  ["frontend", "api", "db"].forEach((n) => health.markHealthy(n));

  // Database fails
  health.markFailed("db");
  health.propagateHealth("db", graph);

  const apiHealth = health.getHealth("api");
  const frontendHealth = health.getHealth("frontend");

  assert(apiHealth.state === HealthState.DEGRADED, "API becomes DEGRADED when DB fails");
  assert(
    frontendHealth.state === HealthState.DEGRADED,
    "Frontend becomes DEGRADED when DB fails"
  );
}

// ============================================================================
// TEST 6: Engine Initialization
// ============================================================================
function testEngineInitialization() {
  console.log("\n⚙️ TEST 6: Engine Initialization\n");

  const engine = new DependencyGraphEngine();
  const status = engine.initializePods([
    {
      id: "api",
      name: "api-service",
      status: "Running",
      env: { DB_HOST: "postgres" },
    },
    { id: "db", name: "postgres", status: "Running", env: {} },
  ]);

  assert(status.graph.nodes === 2, "Two nodes in graph");
  assert(status.graph.edges >= 1, "At least one edge (dependency)");
  assert(status.health.total === 2, "Two pods tracked");
}

// ============================================================================
// TEST 7: Failure Detection
// ============================================================================
function testFailureDetection() {
  console.log("\n💥 TEST 7: Failure Detection\n");

  const engine = new DependencyGraphEngine();
  engine.initializePods(mockPods.slice(0, 3)); // frontend, api, cart

  const result = engine.reportFailure("postgres", "OOMKilled");

  assert(
    result.analysis.rootCause === "postgres",
    "Root cause identified correctly"
  );
  assert(
    result.analysis.confidence > 0,
    "Confidence score provided"
  );
  assert(
    result.remediation.length > 0,
    "Remediation suggestions provided"
  );
}

// ============================================================================
// TEST 8: Event Logging
// ============================================================================
function testEventLogging() {
  console.log("\n📋 TEST 8: Event Logging\n");

  const engine = new DependencyGraphEngine();
  engine.initializePods(mockPods.slice(0, 2));

  const initialCount = engine.getEventLog().length;

  engine.addPod({
    id: "new-service",
    name: "new-service",
    status: "Running",
  });

  const finalCount = engine.getEventLog().length;

  assert(finalCount > initialCount, "Events are logged");

  const events = engine.getEventLog();
  const lastEvent = events[events.length - 1];

  assert(lastEvent.type === "pod_added", "Pod addition logged");
  assert(lastEvent.timestamp, "Event has timestamp");
}

// ============================================================================
// Run All Tests
// ============================================================================
function runAllTests() {
  console.log("\n" + "=".repeat(80));
  console.log("🧪 DEPENDENCY ENGINE - UNIT TESTS");
  console.log("=".repeat(80));

  testGraphConstruction();
  testCycleDetection();
  testTransitiveDependencies();
  testHealthScoring();
  testHealthPropagation();
  testEngineInitialization();
  testFailureDetection();
  testEventLogging();

  console.log("\n" + "=".repeat(80));
  console.log(`✅ PASSED: ${passedTests}`);
  console.log(`❌ FAILED: ${failedTests}`);
  console.log("=".repeat(80) + "\n");

  return failedTests === 0;
}

// Run if called directly
if (require.main === module) {
  const success = runAllTests();
  process.exit(success ? 0 : 1);
}

module.exports = { runAllTests };
