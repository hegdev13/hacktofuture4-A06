/**
 * Configuration Module
 * Centralized configuration for the self-healing system
 */

const config = {
  // System Settings
  system: {
    name: 'Agentic Kubernetes Self-Healing System',
    version: '1.0.0',
    maxRetries: 3,
    retryDelayMs: 5000,
    healthCheckIntervalMs: 30000,
  },

  // Severity Thresholds
  severity: {
    thresholds: {
      cpu: { high: 85, critical: 95 },
      memory: { high: 85, critical: 95 },
      restarts: { warning: 3, critical: 5 },
      errorRate: { warning: 10, critical: 25 },
    },
  },

  // RCA Configuration
  rca: {
    maxChainDepth: 5,
    confidenceThreshold: 70,
    dependencyKeys: [
      'DB_HOST', 'DATABASE_URL', 'POSTGRES_HOST',
      'REDIS_URL', 'REDIS_HOST', 'CACHE_HOST',
      'KAFKA_BROKER', 'MQ_HOST', 'API_HOST',
      'UPSTREAM_HOST', 'BACKEND_HOST', 'SERVICE_HOST'
    ],
    relationshipLabels: [
      'depends-on', 'requires', 'connects-to',
      'db', 'database', 'cache', 'queue', 'upstream'
    ],
  },

  // Observer-trigger policy (controls RCA trigger noise filtering)
  observer: {
    thresholds: {
      cpu: 80,
      memory: 85,
      errorRate: 5,
      restartCount: 3,
    },
    stabilityWindowMs: 30000,
    cooldownMs: 60000,
    severityTriggerScore: 70,
    correlationSignalBonus: 10,
    weights: {
      cpu: 20,
      memory: 20,
      errorRate: 30,
      restartCount: 20,
    },
  },

  // Execution Configuration
  execution: {
    dryRun: process.env.DRY_RUN !== 'false', // Set DRY_RUN=false to enable real K8s operations
    timeoutMs: 30000,
    verifyFixes: process.env.VERIFY_FIXES !== 'false', // Verify fixes after execution (default: true)
    verifyTimeoutMs: 60000, // Max time to wait for fix verification
    strategies: [
      'restart_pod',
      'restart_deployment',
      'scale_up',
      'scale_down',
      'rollback',
      'restart_dependency_first',
      'cordon_node',
      'drain_node',
    ],
  },

  // Memory Configuration
  memory: {
    maxEntries: 1000,
    ttlHours: 168, // 7 days
    minConfidenceForLearning: 80,
  },

  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    enableTimeline: true,
    enableColors: true,
  },

  // Adapter Configuration
  adapter: {
    strictMode: false, // Allow missing fields
    defaultValues: {
      namespace: 'default',
      status: 'unknown',
      cpu: 0,
      memory: 0,
      restarts: 0,
    },
  },
};

module.exports = config;
