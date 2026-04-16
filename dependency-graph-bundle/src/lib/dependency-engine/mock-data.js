/**
 * Mock Data for Dependency Graph Engine
 * Simulates a microservices ecosystem (Online Boutique style)
 */

const mockPods = [
  {
    id: "frontend",
    name: "frontend",
    status: "Running",
    restartCount: 0,
    env: {
      API_SERVICE: "api-service",
      CART_SERVICE: "cart-service",
      PRODUCT_SERVICE: "product-service",
      API_URL: "http://api-service:8080",
    },
    logs: "Starting app, connecting to api-service",
  },
  {
    id: "api-service",
    name: "api-service",
    status: "Running",
    restartCount: 0,
    env: {
      DB_HOST: "postgres",
      CACHE_HOST: "redis",
      DATABASE_URL: "postgres://postgres:5432/main",
      REDIS_URL: "redis://redis:6379",
    },
    logs: "App started, listening on port 8080, querying postgres",
  },
  {
    id: "cart-service",
    name: "cart-service",
    status: "Running",
    restartCount: 0,
    env: {
      BACKEND_SERVICE: "api-service",
      REDIS_HOST: "redis",
      DB_SERVICE: "postgres",
    },
    logs: "Connecting to redis for cache, upstream service api-service",
  },
  {
    id: "product-service",
    name: "product-service",
    status: "Running",
    restartCount: 0,
    env: {
      DATABASE_HOST: "postgres",
      DATABASE_URL: "host=postgres dbname=products",
      CACHE_URL: "redis://redis:6379",
    },
    logs: "Querying postgres database, connecting to redis",
  },
  {
    id: "postgres",
    name: "postgres",
    status: "Running",
    restartCount: 0,
    env: {},
    logs: "Database ready",
  },
  {
    id: "redis",
    name: "redis",
    status: "Running",
    restartCount: 0,
    env: {},
    logs: "Redis server started",
  },
  {
    id: "payment-service",
    name: "payment-service",
    status: "Running",
    restartCount: 0,
    env: {
      STRIPE_API_URL: "https://api.stripe.com",
      BACKEND: "api-service",
    },
    logs: "Connecting to api-service",
  },
  {
    id: "email-service",
    name: "email-service",
    status: "Running",
    restartCount: 0,
    env: {
      SMTP_HOST: "smtp.sendgrid.com",
    },
    logs: "Ready to send emails",
  },
];

const mockFailureScenarios = [
  {
    name: "Database Failure",
    description: "PostgreSQL database crashes - affects all services",
    step1: {
      pod: "postgres",
      failure: {
        podStatus: "CrashLoopBackOff",
        restartCount: 8,
        errorRate: 1.0,
        reason: "OOMKilled - Out of memory",
      },
    },
  },
  {
    name: "Cache Service Failure",
    description: "Redis crashes - cart-service and api-service affected",
    step1: {
      pod: "redis",
      failure: {
        podStatus: "CrashLoopBackOff",
        restartCount: 5,
        errorRate: 0.95,
        reason: "Memory exhausted",
      },
    },
  },
  {
    name: "API Service Failure",
    description: "API Service container crashes",
    step1: {
      pod: "api-service",
      failure: {
        podStatus: "CrashLoopBackOff",
        restartCount: 12,
        errorRate: 1.0,
        reason: "Application panic on startup",
      },
    },
  },
  {
    name: "Cascading Failure",
    description: "Database fails, then API fails trying to reconnect",
    step1: {
      pod: "postgres",
      failure: {
        podStatus: "CrashLoopBackOff",
        restartCount: 5,
        errorRate: 1.0,
      },
    },
    step2: {
      pod: "api-service",
      failure: {
        podStatus: "Running",
        restartCount: 15,
        errorRate: 0.9,
        reason: "Cannot connect to database",
      },
    },
  },
];

module.exports = { mockPods, mockFailureScenarios };
