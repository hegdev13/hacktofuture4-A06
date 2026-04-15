#!/usr/bin/env node

/**
 * Start Self-Healing System with Dashboard and Live Metrics
 * This script starts the system with real-time metrics from ngrok
 */

const path = require('path');
const SelfHealingSystem = require('./self-healing-system/main');
const DashboardServer = require('./self-healing-system/dashboard/server');
const logger = require('./self-healing-system/utils/logger');

// Configuration
const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 3456;
const NGROK_URL = process.env.NGROK_URL || 'https://refocus-cement-spud.ngrok-free.dev/pods';
const DRY_RUN = process.env.DRY_RUN !== 'false';

class SystemOrchestrator {
  constructor() {
    this.dashboard = null;
    this.healing = null;
    this.lastHealingTime = null;
    this.autoHealInterval = null;
  }

  async start() {
    logger.banner();
    console.log('\n🚀 Self-Healing System with Live Metrics');
    console.log('═'.repeat(50));
    console.log(`📊 Metrics URL: ${NGROK_URL}`);
    console.log(`🎨 Dashboard:  http://localhost:${DASHBOARD_PORT}`);
    console.log(`🔒 Dry-Run:    ${DRY_RUN ? 'YES ✓ (safe mode)' : 'NO - REAL EXECUTION'}`);
    console.log('═'.repeat(50) + '\n');

    try {
      // 1. Start Dashboard Server
      console.log('📡 Starting dashboard server...');
      this.dashboard = new DashboardServer(DASHBOARD_PORT);
      
      // 2. Setup dashboard trigger handler
      this.dashboard.on('trigger', async () => {
        console.log('\n🎯 Trigger received from dashboard - starting analysis...\n');
        await this.runHealing();
      });

      // 3. Start the server
      this.dashboard.start();

      // 4. Configure metrics in SelfHealingSystem
      SelfHealingSystem.setMetricsUrl(NGROK_URL);
      
      // 5. Register callbacks for dashboard updates
      SelfHealingSystem.onAgentStatus((agent, status, data) => {
        this.dashboard.setAgentStatus(agent, status, data);
      });
      
      SelfHealingSystem.onMetricsUpdate((data) => {
        console.log(`📊 [METRICS] Received ${data.pods?.length || 0} pods from ngrok`);
        this.dashboard.setMetricsData(data);
        
        // Check for pod failures and trigger emergency healing
        this.checkForFailuresAndTrigger(data);
      });

      // 6. Start continuous refresh of metrics
      SelfHealingSystem.startContinuousRefresh(5000); // Refresh every 5 seconds

      // 7. Setup auto-heal interval if enabled
      this.setupAutoHeal();

      // Keep system ready
      console.log('\n✅ System ready!');
      console.log(`   → Dashboard: http://localhost:${DASHBOARD_PORT}`);
      console.log('   → Real-time metrics refresh: ACTIVE (every 5 seconds)');
      console.log('   → Click "Connect Metrics" to start analysis\n');

    } catch (error) {
      logger.error('Failed to start system', error);
      process.exit(1);
    }
  }

  setupAutoHeal() {
    if (process.env.AUTO_RUN === 'true') {
      console.log('⏳ Auto-healing enabled: running analysis every 10 seconds\n');
      
      this.autoHealInterval = setInterval(() => {
        if (!this.dashboard.isRunning) {
          console.log('\n🔄 [AUTO] Running continuous analysis...');
          this.runHealing().catch(err => console.error('Auto-heal error:', err));
        }
      }, 10000); // Every 10 seconds
    }
  }

  async runHealing() {
    this.dashboard.setRunning(true);

    try {
      const result = await SelfHealingSystem.runSelfHealingSystem({
        onAnalysis: (analysis) => {
          console.log(`📊 Observer: Analyzing cluster (${analysis.issues?.length || 0} issues detected)`);
        },
        onDetection: (detection) => {
          console.log(`🔍 Detector: Confirming issues (${detection.confirmedIssues?.length || 0} confirmed)`);
        },
        onRCA: (rcaData) => {
          this.dashboard.setRCAResult(rcaData);
        }
      });

      // Display result
      const timestamp = new Date().toLocaleTimeString();
      console.log(`\n${timestamp} 📈 Healing Result`);
      console.log('─'.repeat(50));
      console.log(`✓ Status:     ${result.success ? '✅ HEALTHY' : '❌ ISSUES'}`);
      console.log(`✓ Health:     ${result.finalHealth}`);
      console.log(`✓ Issues:     ${result.issuesFound}`);
      console.log(`✓ Fixes:      ${result.fixesApplied}`);
      console.log('─'.repeat(50) + '\n');

      // Update dashboard with final result
      this.dashboard.updateState({
        healthy: result.success,
        issues: result.remainingIssues || [],
        timeline: result.timeline || []
      });

    } catch (error) {
      console.error('❌ Healing error:', error.message);
    } finally {
      this.dashboard.setRunning(false);
    }
  }

  checkForFailuresAndTrigger(metricsData) {
    if (!metricsData.pods) return;

    // Check for failed pods
    const failedPods = metricsData.pods.filter(
      pod => pod.status === 'Failed' || pod.status === 'CrashLoopBackOff'
    );

    if (failedPods.length > 0) {
      // Check if we recently ran healing (within last 30 seconds)
      const now = Date.now();
      if (this.lastHealingTime && now - this.lastHealingTime < 30000) {
        return; // Too recent, skip
      }

      console.log(`\n🚨 [EMERGENCY] Detected ${failedPods.length} failed pod(s):`);
      failedPods.forEach(pod => {
        console.log(`   - ${pod.name} (${pod.status})`);
      });

      // Check if AUTO_TRIGGER is enabled or if critical failure
      const hasCritical = failedPods.some(p => 
        p.name.includes('api-gateway') || p.name.includes('auth-service')
      );

      if (process.env.AUTO_TRIGGER === 'true' || hasCritical) {
        console.log('🔴 Triggering emergency healing for critical pod failure...\n');
        this.lastHealingTime = now;
        
        // Run healing immediately
        this.runHealing().catch(err => {
          console.error('Emergency healing failed:', err.message);
        });
      }
    }
  }
}

// Start the system
const orchestrator = new SystemOrchestrator();
orchestrator.start();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n📛 Shutting down gracefully...');
  SelfHealingSystem.stopContinuousRefresh();
  if (orchestrator.autoHealInterval) {
    clearInterval(orchestrator.autoHealInterval);
  }
  process.exit(0);
});
