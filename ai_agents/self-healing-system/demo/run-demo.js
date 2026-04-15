/**
 * Demo Runner with Modern Dashboard
 * Run self-healing system with real-time web UI
 */

const DashboardServer = require('../dashboard/server');
const SelfHealingSystem = require('../main');
const logger = require('../utils/logger');

// Create dashboard server
const server = new DashboardServer(3456);

// Bridge system events to dashboard
class DemoRunner {
  constructor() {
    this.system = SelfHealingSystem;
    this.server = server;
    this.isRunning = false;
  }

  async start() {
    console.log('🚀 Starting Self-Healing System');
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║          SELf-HEALING SYSTEM                                   ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║  Open your browser:                                            ║');
    console.log('║    http://localhost:3456                                       ║');
    console.log('║    http://127.0.0.1:3456                                       ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');

    // Check if metrics URL is configured
    if (process.env.METRICS_URL) {
      console.log(`📡 Using metrics endpoint: ${process.env.METRICS_URL}`);
      this.system.setMetricsUrl(process.env.METRICS_URL);
    } else {
      console.log('⚠️  No METRICS_URL configured - using mock data');
      console.log('   Set METRICS_URL env var for real-time metrics');
    }
    console.log('');

    // Start dashboard
    server.start();

    // Listen for trigger from dashboard
    server.on('trigger', () => {
      if (!this.isRunning) {
        this.runHealingCycle();
      }
    });

    // Optionally auto-run once
    if (process.env.AUTO_RUN === 'true') {
      setTimeout(() => this.runHealingCycle(), 3000);
    }
  }

  async runHealingCycle() {
    if (this.isRunning) {
      console.log('⚠️  Healing cycle already in progress');
      return;
    }

    this.isRunning = true;
    server.setRunning(true);

    console.log('▶️  Starting self-healing cycle...');

    // Reset state
    server.updateState({
      healthy: true,
      issues: [],
      agents: {
        observer: { status: 'idle' },
        detector: { status: 'idle' },
        rca: { status: 'idle' },
        executor: { status: 'idle' }
      },
      memory: { totalLearnings: 0, successRate: 100 },
      timeline: [],
      rca: null
    });

    // Clear old timeline
    logger.clear();

    try {
      // Run the actual self-healing system
      const result = await this.system.runSelfHealingSystem({
        onAnalysis: (analysis) => {
          if (!analysis.healthy) {
            server.updateState({
              healthy: false,
              issues: analysis.issues
            });
          }
        },
        onDetection: (detection) => {
          if (detection.hasIssues) {
            server.updateState({
              issues: detection.confirmedIssues
            });
          }
        },
        onRCA: (rca) => {
          server.setRCAResult(rca);
        }
      });

      // Update final state
      server.updateState({
        healthy: result.success,
        memory: {
          totalLearnings: this.system.getMemoryStats().totalLearnings,
          successRate: this.system.getMemoryStats().successRate
        }
      });

      console.log('✅ Healing cycle complete');
      console.log(`   Success: ${result.success}`);
      console.log(`   Attempts: ${result.attempts}`);
      console.log(`   Issues found: ${result.issuesFound || 0}`);
      console.log(`   Fixes applied: ${result.fixesApplied || 0}`);

    } catch (error) {
      console.error('❌ Healing cycle failed:', error.message);
      server.addTimelineEvent({
        type: 'error',
        description: `Healing cycle failed: ${error.message}`
      });
    } finally {
      this.isRunning = false;
      server.setRunning(false);
      console.log('');
      console.log('💡 Click "Run Self-Healing" to run another cycle');
    }
  }

  wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Run demo
const runner = new DemoRunner();
runner.start();
