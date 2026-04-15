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

  // Execution Configuration
  execution: {
    dryRun: true, // Set to false to enable real K8s operations
    timeoutMs: 30000,
    strategies: [
      'restart_pod',
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

  // External Knowledge Base Configuration
  knowledgeBase: {
    enabled: process.env.KB_ENABLED !== 'false',
    provider: process.env.KB_PROVIDER || 'gemini',
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
    timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 8000),
    minConfidence: Number(process.env.KB_MIN_CONFIDENCE || 70),
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
