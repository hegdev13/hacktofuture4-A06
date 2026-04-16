/**
 * Dependency Graph Engine - Complete Example
 * Demonstrates all features: graph building, failure detection, RCA, and healing
 */

const DependencyGraphEngine = require("./engine");
const { mockPods, mockFailureScenarios } = require("./mock-data");

// Helper: Pretty print JSON
const pp = (obj) => console.log(JSON.stringify(obj, null, 2));

async function runExample() {
  console.log("\n" + "=".repeat(80));
  console.log("🔧 DEPENDENCY GRAPH ENGINE - COMPLETE EXAMPLE");
  console.log("=".repeat(80) + "\n");

  // ============================================================================
  // STEP 1: Initialize Engine
  // ============================================================================
  console.log("📦 STEP 1: Initialize Engine with Pods\n");

  const engine = new DependencyGraphEngine();
  const initialStatus = engine.initializePods(mockPods);

  console.log("✓ Initialized with", initialStatus.graph.nodes, "nodes and", initialStatus.graph.edges, "edges\n");
  console.log("Initial System Status:");
  pp(initialStatus.health);

  // ============================================================================
  // STEP 2: Display Graph Structure
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("🔗 STEP 2: Dependency Graph Structure\n");

  const graphExport = engine.exportGraph();
  for (const [nodeName, nodeData] of Object.entries(graphExport)) {
    console.log(`\n${nodeName}:`);
    console.log(`  Depends on: ${nodeData.dependsOn.length > 0 ? nodeData.dependsOn.join(", ") : "(none)"}`);
    console.log(`  Dependents: ${nodeData.dependents.length > 0 ? nodeData.dependents.join(", ") : "(none)"}`);
  }

  // ============================================================================
  // STEP 3: Simulate Failure (Database Crash)
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("💥 STEP 3: Simulate Database Failure\n");

  const failureScenario = mockFailureScenarios[0]; // Database failure
  console.log(`Scenario: ${failureScenario.name}`);
  console.log(`Description: ${failureScenario.description}\n`);

  const failureResult = engine.reportFailure("postgres", "OOMKilled - Out of memory");

  console.log("📊 Failure Analysis Result:");
  pp({
    rootCause: failureResult.analysis.rootCause,
    confidence: failureResult.analysis.confidence,
    affectedServices: failureResult.analysis.affected,
    failurePath: failureResult.analysis.failurePath,
  });

  console.log("\n🎯 Impact Assessment:");
  pp({
    immediateImpact: failureResult.impact.immediateImpact,
    totalAffected: failureResult.impact.totalAffected,
    severity: failureResult.impact.severity,
  });

  console.log("\n🔧 Suggested Remediation:");
  failureResult.remediation.forEach((item, i) => {
    console.log(`  ${i + 1}. [Priority ${item.priority}] ${item.action}`);
    console.log(`     Command: ${item.command}`);
  });

  // ============================================================================
  // STEP 4: Check System Health After Failure
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("❌ STEP 4: System Health After Failure\n");

  const statusAfterFailure = engine.getStatus();
  console.log("Updated System Status:");
  pp({
    health: statusAfterFailure.health,
    systemHealth: statusAfterFailure.systemHealth.systemHealth,
  });

  // Analyze specific pods
  console.log("\n📋 Detailed Analysis:");
  const pods = ["frontend", "api-service", "cart-service", "postgres"];
  for (const pod of pods) {
    const analysis = engine.analyzePod(pod);
    console.log(`\n${pod}:`);
    console.log(`  State: ${analysis.health.state}`);
    console.log(`  Score: ${(analysis.health.score * 100).toFixed(1)}%`);
    if (analysis.dependents.direct.length > 0) {
      console.log(`  Dependents: ${analysis.dependents.direct.join(", ")}`);
    }
  }

  // ============================================================================
  // STEP 5: Simulate Recovery/Healing
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("✅ STEP 5: Simulate Pod Recovery/Healing\n");

  console.log("🔧 Performing healing action: Restarting postgres pod...\n");

  const healingResult = engine.reportHealing("postgres");

  console.log("✓ Healing Result:");
  pp({
    recovered: healingResult.recovered,
    systemHealth: healingResult.systemHealth.systemHealth,
    totalAffected: healingResult.systemHealth.totalAffected,
  });

  // ============================================================================
  // STEP 6: Verify System Recovery
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("🎊 STEP 6: Verify System Recovery\n");

  const finalStatus = engine.getStatus();
  console.log("Final System Status:");
  pp(finalStatus.health);

  // ============================================================================
  // STEP 7: Event Log
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("📋 STEP 7: Event Log\n");

  const eventLog = engine.getEventLog();
  console.log(`Total Events: ${eventLog.length}\n`);

  eventLog.forEach((event, i) => {
    console.log(`[${i + 1}] ${event.type.toUpperCase()} - ${event.timestamp}`);
  });

  // ============================================================================
  // STEP 8: Dynamic Pod Operations
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("🔄 STEP 8: Dynamic Pod Operations\n");

  console.log("Adding new pod: notification-service\n");

  const newPodId = engine.addPod({
    id: "notification-service",
    name: "notification-service",
    status: "Running",
    restartCount: 0,
    env: {
      API_SERVICE: "api-service",
      EMAIL_SERVICE: "email-service",
      API_URL: "http://api-service:8080",
    },
    logs: "Connecting to api-service",
  });

  console.log(`✓ Added pod: ${newPodId}`);
  console.log('\nUpdated graph has', engine.graph.getStats().nodeCount, 'nodes and', engine.graph.getStats().edgeCount, 'edges');

  // ============================================================================
  // STEP 9: Complex Scenario - Cascading Failure
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("🌊 STEP 9: Cascading Failure Scenario\n");

  console.log("Simulating cascading failure:\n");
  console.log("1. Redis fails...");
  engine.reportFailure("redis", "Connection timeout");

  console.log("2. Cart Service degrades (depends on Redis)");
  engine.updatePodHealth("cart-service", {
    podStatus: "Running",
    restartCount: 3,
    errorRate: 0.7,
    reason: "Cannot connect to Redis - using fallback",
  });

  const cascadingAnalysis = engine.rcaEngine.analyzeSystemHealth();
  console.log("\nSystem Analysis After Cascading Failure:");
  pp({
    systemHealth: cascadingAnalysis.systemHealth,
    rootCauses: cascadingAnalysis.rootCauses,
    totalAffected: cascadingAnalysis.totalAffected,
  });

  // ============================================================================
  // STEP 10: Export Final State
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("📤 STEP 10: Final State Export\n");

  const finalAnalysis = engine.rcaEngine.analyzeSystemHealth();
  console.log("Final System Analysis:");
  pp({
    summary: finalAnalysis.summary,
    rootCauses: finalAnalysis.rootCauses.map((rc) => ({
      rootCause: rc.rootCause,
      confidence: rc.confidence,
    })),
  });

  console.log("\n" + "=".repeat(80));
  console.log("✨ Example completed successfully!");
  console.log("=".repeat(80) + "\n");
}

// Run if called directly
if (require.main === module) {
  runExample().catch(console.error);
}

module.exports = { runExample };
