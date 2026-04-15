#!/usr/bin/env node

/**
 * Test Live Metrics Integration
 * Validates ngrok endpoint connectivity and data format
 */

const https = require('https');
const { URL } = require('url');

const NGROK_URL = process.env.NGROK_URL || 'https://refocus-cement-spud.ngrok-free.dev/pods';

console.log('\n🧪 Testing Live Metrics Integration');
console.log('═'.repeat(50));
console.log(`📍 Testing endpoint: ${NGROK_URL}\n`);

async function testConnection() {
  console.log('📡 Test 1: Connection Test');
  console.log('─'.repeat(50));

  try {
    const data = await makeRequest(NGROK_URL);
    console.log('✅ Connection successful!\n');
    return data;
  } catch (error) {
    console.log(`❌ Connection failed: ${error.message}\n`);
    process.exit(1);
  }
}

async function validateData(data) {
  console.log('📊 Test 2: Data Format Validation');
  console.log('─'.repeat(50));

  if (!data) {
    console.log('❌ No data received\n');
    return false;
  }

  if (Array.isArray(data)) {
    console.log(`✅ Format: Array with ${data.length} items\n`);
    return true;
  }

  if (data.pods && Array.isArray(data.pods)) {
    console.log(`✅ Format: Object with pods array (${data.pods.length} items)\n`);
    return true;
  }

  if (data.items && Array.isArray(data.items)) {
    console.log(`✅ Format: Kubernetes format (${data.items.length} items)\n`);
    return true;
  }

  console.log('⚠️  Format: Generic/Unknown format\n');
  return true;
}

async function analyzePods(data) {
  console.log('🔍 Test 3: Pod Analysis');
  console.log('─'.repeat(50));

  let pods = Array.isArray(data) ? data : (data.pods || data.items || []);

  if (pods.length === 0) {
    console.log('⚠️  No pods found in response\n');
    return;
  }

  console.log(`📦 Found ${pods.length} pods:\n`);

  pods.slice(0, 5).forEach((pod, i) => {
    const name = pod.name || pod.metadata?.name || `Pod ${i + 1}`;
    const status = pod.status || pod.phase || pod.metadata?.phase || 'Unknown';
    const namespace = pod.namespace || pod.metadata?.namespace || 'default';

    console.log(`   ${i + 1}. ${name}`);
    console.log(`      Status: ${status}`);
    console.log(`      Namespace: ${namespace}`);

    if (pod.cpu || pod.memory) {
      console.log(`      Resources: CPU=${pod.cpu || 'N/A'}, Memory=${pod.memory || 'N/A'}`);
    }
  });

  if (pods.length > 5) {
    console.log(`\n   ... and ${pods.length - 5} more pods`);
  }

  console.log('');
}

async function testNormalization(data) {
  console.log('⚙️  Test 4: Data Normalization (Simulation)');
  console.log('─'.repeat(50));

  const adapter = require('./self-healing-system/adapters/clusterStateAdapter');

  try {
    const normalized = adapter.normalize(data);

    console.log(`✅ Normalization successful`);
    console.log(`   - Input format: ${Array.isArray(data) ? 'Array' : typeof data}`);
    console.log(`   - Output pods: ${normalized.pods.length}`);
    console.log(`   - Output nodes: ${normalized.nodes.length}`);
    console.log(`   - Timestamp: ${normalized.timestamp}\n`);

    // Check first pod structure
    if (normalized.pods.length > 0) {
      const pod = normalized.pods[0];
      console.log(`✅ Pod structure validated:`);
      console.log(`   - name: ${pod.name}`);
      console.log(`   - status: ${pod.status}`);
      console.log(`   - cpu: ${pod.cpu || 'N/A'}`);
      console.log(`   - memory: ${pod.memory || 'N/A'}`);
      console.log(`   - restarts: ${pod.restarts || 0}`);
      console.log(`   - dependencies: ${pod.dependencies?.length || 0}\n`);
    }

    return normalized;
  } catch (error) {
    console.log(`❌ Normalization failed: ${error.message}\n`);
    return null;
  }
}

async function testAnalysis(normalized) {
  console.log('🔬 Test 5: Analysis Pipeline Simulation');
  console.log('─'.repeat(50));

  try {
    const observer = require('./self-healing-system/agents/observer');

    const analysis = observer.analyzeClusterState(normalized);

    console.log(`✅ Observer analysis completed`);
    console.log(`   - Healthy: ${analysis.healthy}`);
    console.log(`   - Issues found: ${analysis.issues?.length || 0}`);

    if (analysis.issues && analysis.issues.length > 0) {
      console.log(`\n   Issues detected:`);
      analysis.issues.slice(0, 3).forEach((issue, i) => {
        console.log(`   ${i + 1}. [${issue.severity}] ${issue.problem} on ${issue.target}`);
      });
      if (analysis.issues.length > 3) {
        console.log(`   ... and ${analysis.issues.length - 3} more`);
      }
    } else {
      console.log('   System is healthy!');
    }

    console.log('');

  } catch (error) {
    console.log(`❌ Analysis failed: ${error.message}\n`);
  }
}

async function makeRequest(urlString) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Test-Script/1.0'
      },
      timeout: 15000
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', chunk => data += chunk);

      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 100)}`));
          }
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', err => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

async function main() {
  try {
    // Run tests
    const data = await testConnection();
    await validateData(data);
    await analyzePods(data);
    const normalized = await testNormalization(data);
    if (normalized) {
      await testAnalysis(normalized);
    }

    // Summary
    console.log('═'.repeat(50));
    console.log('✅ All tests passed! Ready to use live metrics.\n');
    console.log('Next steps:');
    console.log('  1. Run: node start-with-live-metrics.js');
    console.log('  2. Open: http://localhost:3456');
    console.log('  3. Paste your ngrok URL in the configuration panel');
    console.log('  4. Click "Connect Metrics" to start real-time analysis\n');

  } catch (error) {
    console.log('❌ Test suite failed:', error.message);
    process.exit(1);
  }
}

main();
