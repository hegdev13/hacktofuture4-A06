/**
 * Dependency Extractor Module
 * Builds dependency graph from multiple sources:
 * - Environment variables
 * - Config data (YAML/JSON)
 * - Log parsing
 * 
 * This module extracts service relationships without performing analysis
 */

class DependencyExtractor {
  /**
   * Extract dependencies from environment variables
   * Looks for patterns like SERVICE_URL, DEPENDENCY_HOST, etc.
   * 
   * @param {Object} env - Environment variables
   * @returns {Array<{from, to, type}>}
   */
  static extractFromEnv(env = process.env) {
    const dependencies = [];
    const servicePattern = /_(?:URL|HOST|ENDPOINT|DATABASE|CACHE|SERVICE)=/i;
    const services = new Set();

    // Find all services mentioned in env
    for (const [key, value] of Object.entries(env)) {
      if (servicePattern.test(key)) {
        services.add(key);
      }
    }

    // Example: API_DATABASE_URL=postgres://db:5432 → API depends on DB
    for (const key of services) {
      const parts = key.split('_');
      if (parts.length >= 2) {
        const serviceA = parts[0].toLowerCase();
        const depType = parts.slice(1, -1).join('_').toLowerCase();
        
        // Classify as hard/soft
        const type = ['database', 'db', 'postgres', 'mysql'].includes(depType)
          ? 'hard'
          : 'soft';

        dependencies.push({
          from: serviceA,
          to: depType,
          type,
          source: 'env',
        });
      }
    }

    return dependencies;
  }

  /**
   * Extract dependencies from config data
   * Looks for nested service definitions
   * 
   * @param {Object} config - Configuration object
   * @returns {Array<{from, to, type}>}
   */
  static extractFromConfig(config = {}) {
    const dependencies = [];

    /**
     * Recursive function to find dependencies in config
     */
    const traverse = (obj, currentService = null) => {
      if (!obj || typeof obj !== 'object') return;

      for (const [key, value] of Object.entries(obj)) {
        // Look for dependency indicators
        if (
          ['depends_on', 'dependencies', 'requires', 'needs'].includes(
            key.toLowerCase()
          )
        ) {
          // Array of dependencies
          if (Array.isArray(value)) {
            value.forEach(dep => {
              if (typeof dep === 'string' && currentService) {
                dependencies.push({
                  from: currentService,
                  to: dep,
                  type: 'hard',
                  source: 'config',
                });
              }
            });
          }
          // Object of dependencies
          else if (typeof value === 'object' && currentService) {
            for (const depName of Object.keys(value)) {
              dependencies.push({
                from: currentService,
                to: depName,
                type: value[depName].optional ? 'soft' : 'hard',
                source: 'config',
              });
            }
          }
        }

        // Recurse into nested objects
        if (typeof value === 'object' && value !== null) {
          traverse(value, key.toLowerCase());
        }
      }
    };

    traverse(config);
    return dependencies;
  }

  /**
   * Extract dependencies from log patterns
   * Looks for connection messages in logs
   * 
   * @param {Array<string>} logs - Array of log lines
   * @returns {Array<{from, to, type}>}
   */
  static extractFromLogs(logs = []) {
    const dependencies = [];
    const patterns = [
      // "api connecting to db"
      /(\w+)\s+(?:connecting|connected)\s+to\s+(\w+)/i,
      // "contacting service: cache"
      /contacting\s+(?:service|host)[:\s]+(\w+)/i,
      // "calling api-service"
      /calling\s+([a-z\-]+)/i,
      // "postgres connection error"
      /(?:error|failed).*(?:connecting|connection).*(?:to|at)\s+([a-z\-]+)/i,
      // "redis timeout"
      /timeout.*\(([a-z\-]+)\)/i,
    ];

    const extractedDeps = new Set();

    for (const log of logs) {
      for (const pattern of patterns) {
        const match = log.match(pattern);
        if (match) {
          const from = match[1]?.toLowerCase();
          const to = match[2]?.toLowerCase() || match[1]?.toLowerCase();

          if (from && to && from !== to) {
            const depStr = `${from}→${to}`;
            if (!extractedDeps.has(depStr)) {
              extractedDeps.add(depStr);
              dependencies.push({
                from,
                to,
                type: 'hard', // Default to hard from logs
                source: 'logs',
              });
            }
          }
        }
      }
    }

    return dependencies;
  }

  /**
   * Merge dependencies from multiple sources
   * Removes duplicates and conflicts
   * 
   * @param {Array<Array>} depArrays - Arrays of dependencies from different sources
   * @returns {Array<{from, to, type}>}
   */
  static mergeDependencies(...depArrays) {
    const merged = new Map();

    for (const depArray of depArrays) {
      for (const dep of depArray) {
        const key = `${dep.from}→${dep.to}`;

        if (merged.has(key)) {
          // If conflicts, prefer hard over soft
          const existing = merged.get(key);
          if (dep.type === 'hard' && existing.type === 'soft') {
            merged.set(key, dep);
          }
        } else {
          merged.set(key, dep);
        }
      }
    }

    return Array.from(merged.values());
  }

  /**
   * Build a DependencyGraph from extracted relationships
   * 
   * @param {Array<{from, to, type}>} dependencies - Extracted dependencies
   * @param {DependencyGraph} graph - Graph instance to populate
   */
  static buildGraph(dependencies, graph) {
    const addedServices = new Set();

    // First pass: Add all services as nodes
    for (const dep of dependencies) {
      if (!addedServices.has(dep.from)) {
        graph.addNode(dep.from);
        addedServices.add(dep.from);
      }
      if (!addedServices.has(dep.to)) {
        graph.addNode(dep.to);
        addedServices.add(dep.to);
      }
    }

    // Second pass: Add edges
    for (const dep of dependencies) {
      try {
        graph.addEdge(dep.from, dep.to, dep.type);
      } catch (err) {
        console.warn(`Could not add edge: ${err.message}`);
      }
    }

    return graph;
  }

  /**
   * Validate graph for cycles and inconsistencies
   * 
   * @param {DependencyGraph} graph - Graph to validate
   * @returns {Object} - { valid: boolean, issues: Array }
   */
  static validateGraph(graph) {
    const issues = [];

    // Check for cycles
    if (graph.hasCycle()) {
      issues.push('CYCLE_DETECTED: Graph contains circular dependencies');
    }

    // Check for isolated nodes
    for (const [service, state] of Object.entries(graph.getAllNodes())) {
      const deps = graph.getDependencies(service);
      const dependents = graph.getDependents(service);

      if (deps.length === 0 && dependents.length === 0) {
        issues.push(`ISOLATED: ${service} has no dependencies or dependents`);
      }
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  /**
   * Example: Build from mock data
   * 
   * @returns {Object} - { dependencies, config, logs }
   */
  static getMockData() {
    const mockEnv = {
      API_DATABASE_URL: 'postgres://db:5432/api',
      API_CACHE_URL: 'redis://cache:6379',
      FRONTEND_API_HOST: 'api:3000',
    };

    const mockConfig = {
      services: {
        'api': { depends_on: ['database'] },
        'database': { depends_on: [] },
        'frontend': { depends_on: ['api'] },
      },
    };

    const mockLogs = [
      '[api] Connecting to database',
      '[frontend] Connected to api service',
      '[api] Redis cache timeout',
    ];

    return { mockEnv, mockConfig, mockLogs };
  }
}

module.exports = DependencyExtractor;
