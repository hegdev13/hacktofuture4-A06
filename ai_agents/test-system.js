#!/usr/bin/env node

/**
 * Test script to verify self-healing system with real-time metrics
 */

const path = require('path');

// Set required env vars for testing
process.env.METRICS_URL = process.env.METRICS_URL || 'https://refocus-cement-spud.ngrok-free.dev/pods';

const SelfHealingSystem = require('./self-healing-system/main');
const logger = require('./self-healing-system/utils/logger');

console.log('🧪 Testing Self-Healing System');
console.log('═'.repeat(50));
console.log(`📊 Metrics URL: ${process.env.METRICS_URL}`);
console.log('');

async function testMetricsFetching() {
  console.log('Test 1: Fetching real-time metrics...');
  try {
    const metricsFetcher = require('./self-healing-system/utils/metricsFetcher');
    metricsFetcher.setMetricsUrl(process.env.METRICS_URL);

    const metrics = await metricsFetcher.fetchMetrics();
    console.log(`✅ Metrics fetched successfully!`);
    console.log(`   - Source: ${metrics.source}`);
    console.log(`   - Pods: ${metrics.pods?.length || 0}`);
    console.log(`   - Timestamp: ${metrics.timestamp}`);

    if (metrics.pods && metrics.pods.length > 0) {
      console.log('   - Sample pods:');
      metrics.pods.slice(0, 3).forEach(pod => {
        console.log(`     • ${pod.name} (${pod.status}) - CPU: ${pod.cpu}%, Mem: ${pod.memory}%`);
      });
    }
    return metrics;
  } catch (error) {
    console.error(`❌ Failed to fetch metrics: ${error.message}`);
    return null;
  }
}

async function testSystemRun(metrics) {
  console.log('');
  console.log('Test 2: Running self-healing system...');

  try {
    // Set the metrics URL
    SelfHealingSystem.setMetricsUrl(process.env.METRICS_URL);

    // Set up callbacks to monitor progress
    let rcaData = null;
    SelfHealingSystem.onAgentStatus((agent, status, data) => {
      console.log(`   [${agent}] ${status}`);
    });

    const result = await SelfHealingSystem.runSelfHealingSystem({
      onAnalysis: (analysis) => {
        console.log(`   📊 Observer: ${analysis.issues?.length || 0} issues detected`);
      },
      onDetection: (detection) => {
        console.log(`   🔍 Detector: ${detection.confirmedIssues?.length || 0} issues confirmed`);
      },
      onRCA: (rca) => {
        rcaData = rca;
        console.log(`   🌳 RCA: Root cause identified - ${rca.rootCause || 'None'} (${rca.confidence}% confidence)`);
        if (rca.chainDetails && rca.chainDetails.length > 0) {
          console.log(`       Chain length: ${rca.chainDetails.length} nodes`);
        }
      }
    });

    console.log('');
    console.log('✅ Self-healing system completed!');
    console.log(`   Success: ${result.success}`);
    console.log(`   Health: ${result.finalHealth}`);
    console.log(`   Issues found: ${result.issuesFound}`);
    console.log(`   Fixes applied: ${result.fixesApplied}`);

    if (rcaData) {
      console.log('');
      console.log('📈 RCA Results:');
      console.log(`   Root Cause: ${rcaData.rootCause}`);
      console.log(`   Confidence: ${rcaData.confidence}%`);
      console.log(`   Reasoning: ${rcaData.reasoning}`);
      if (rcaData.chainDetails) {
        console.log(`   Dependency Chain:`);
        rcaData.chainDetails.forEach((step, i) => {
          console.log(`     ${i + 1}. ${step.name} (depth: ${step.depth}) - ${step.health?.healthy ? 'Healthy' : 'Unhealthy'}`);
        });
      }
    }

    return result;
  } catch (error) {
    console.error(`❌ System run failed: ${error.message}`);
    console.error(error.stack);
    return null;
  }
}

async function main() {
  const metrics = await testMetricsFetching();

  if (metrics && metrics.pods && metrics.pods.length > 0) {
    await testSystemRun(metrics);
  } else {
    console.log('');
    console.log('⚠️  No metrics available - cannot run full test');
    console.log('   Make sure your ngrok URL is accessible and returning pod data');
  }

  console.log('');
  console.log('═'.repeat(50));
  console.log('Test complete!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
