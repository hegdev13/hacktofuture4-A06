/**
 * Dependency Graph System - Module Exports
 * Unified access to all graph and propagation components
 */

// Comprehensive RCA system (with graph + RCA + analysis)
const DependencyGraphRCA = require('./modules/graph');
const RCAEngine = require('./modules/rca');

// Pure propagation system (state management only, NO RCA)
const DependencyGraph = require('./modules/dependency-graph');
const DependencyExtractor = require('./modules/dependency-extractor');

module.exports = {
  // Pure Propagation System (NEW - NO RCA)
  DependencyGraph,
  DependencyExtractor,

  // Comprehensive RCA System (LEGACY - with analysis)
  DependencyGraphRCA,
  RCAEngine,

  // Utilities
  createDefaultExample: () => {
    const graph = new DependencyGraph();
    
    // Add standard nodes
    ['frontend', 'api', 'database', 'cache'].forEach(name => {
      graph.addNode(name);
    });
    
    // Add standard edges
    graph.addEdge('frontend', 'api', 'hard');
    graph.addEdge('api', 'database', 'hard');
    graph.addEdge('api', 'cache', 'soft');
    
    return graph;
  },

  // For testing
  runPropagationExample: () => {
    require('./propagation-example');
  },

  runFullExample: () => {
    require('./example');
  },

  runTests: () => {
    require('./tests');
  },

  // Quick start
  quickStart: function() {
    console.log('\n=== Dependency Graph System - Quick Start ===\n');
    
    const graph = this.createDefaultExample();
    
    console.log('✓ Created example graph: frontend → api → database');
    console.log('✓ Pure propagation system initialized\n');
    
    console.log('Next steps:\n');
    console.log('1. Graph operations:');
    console.log('   - graph.updateNodeState("database", { status: "FAILED" })');
    console.log('   - graph.getNodeState("api")');
    console.log('   - graph.printGraph()\n');
    
    console.log('2. Dependency extraction:');
    console.log('   - DependencyExtractor.extractFromEnv(process.env)');
    console.log('   - DependencyExtractor.extractFromConfig(config)');
    console.log('   - DependencyExtractor.buildGraph(deps, graph)\n');
    
    console.log('3. Run examples:');
    console.log('   - npm run propagation      (Pure propagation demo)');
    console.log('   - npm run example          (Comprehensive RCA demo)');
    console.log('   - npm run test:graph       (RCA tests)');
    console.log('   - npm run test:propagation (Propagation demo)\n');
    
    return graph;
  }
};
