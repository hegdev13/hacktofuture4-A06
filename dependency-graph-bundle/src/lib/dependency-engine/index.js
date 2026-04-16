/**
 * Dependency Engine - Main Export
 * Unified access to all engine components
 */

const DependencyGraphEngine = require("./engine");
const DependencyGraph = require("./graph");
const { HealthMonitor, HealthState } = require("./health");
const RCAEngine = require("./rca");
const DependencyExtractor = require("./dependency-extractor");
const { mockPods, mockFailureScenarios } = require("./mock-data");

module.exports = {
  // Main engine
  DependencyGraphEngine,

  // Core components
  DependencyGraph,
  HealthMonitor,
  HealthState,
  RCAEngine,
  DependencyExtractor,

  // Mock data for testing
  mockPods,
  mockFailureScenarios,

  // Export all
  all: {
    engine: DependencyGraphEngine,
    graph: DependencyGraph,
    health: { HealthMonitor, HealthState },
    rca: RCAEngine,
    extractor: DependencyExtractor,
    data: { mockPods, mockFailureScenarios },
  },
};
