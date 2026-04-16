#!/usr/bin/env node

/**
 * SRE Decision Studio - Dashboard Launcher
 *
 * This script starts both:
 * 1. Mock Metrics Server (port 5555) - provides Kubernetes-like metrics
 * 2. Dashboard Server (port 3000) - serves the web UI
 *
 * Usage: node start-dashboard.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 3000;
const METRICS_PORT = 5555;

// MIME types for static files
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ANSI colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function printBanner() {
  console.clear();
  log('╔══════════════════════════════════════════════════════════════╗', 'cyan');
  log('║                                                              ║', 'cyan');
  log('║        🚀 SRE Decision Studio - Dashboard Launcher          ║', 'cyan');
  log('║                                                              ║', 'cyan');
  log('╠══════════════════════════════════════════════════════════════╣', 'cyan');
  log('║  This launcher starts:                                       ║', 'yellow');
  log('║  • Mock Metrics Server  → http://localhost:5555            ║', 'green');
  log('║  • Dashboard Web UI     → http://localhost:3000            ║', 'green');
  log('║                                                              ║', 'cyan');
  log('║  Features:                                                   ║', 'yellow');
  log('║  • Live pod status monitoring                               ║', 'green');
  log('║  • Real-time cluster metrics                                ║', 'green');
  log('║  • Node resource usage visualization                        ║', 'green');
  log('║  • Active alerts display                                    ║', 'green');
  log('║  • SRE decision pipeline simulation                         ║', 'green');
  log('║                                                              ║', 'cyan');
  log('╚══════════════════════════════════════════════════════════════╝', 'cyan');
  console.log('');
}

function startMockMetricsServer() {
  return new Promise((resolve, reject) => {
    log('📡 Starting Mock Metrics Server...', 'yellow');

    // Check if mock-metrics-server.js exists
    const mockServerPath = path.join(__dirname, 'mock-metrics-server.js');
    if (!fs.existsSync(mockServerPath)) {
      reject(new Error('mock-metrics-server.js not found'));
      return;
    }

    // Start the mock server as a child process
    const mockServer = spawn('node', ['mock-metrics-server.js'], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    mockServer.stdout.on('data', (data) => {
      const output = data.toString().trim();
      if (output.includes('Mock Metrics API running')) {
        log(`✅ Mock Metrics Server running on port ${METRICS_PORT}`, 'green');
        resolve(mockServer);
      }
      // Forward other output
      if (output && !output.includes('Mock Metrics API running')) {
        console.log(`[Metrics] ${output}`);
      }
    });

    mockServer.stderr.on('data', (data) => {
      console.error(`[Metrics Error] ${data.toString().trim()}`);
    });

    mockServer.on('error', (err) => {
      reject(err);
    });

    // Timeout if server doesn't start
    setTimeout(() => {
      reject(new Error('Timeout waiting for mock metrics server'));
    }, 10000);
  });
}

function startDashboardServer() {
  return new Promise((resolve, reject) => {
    log('🎨 Starting Dashboard Server...', 'yellow');

    const server = http.createServer((req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Determine file path
      let filePath;
      if (req.url === '/') {
        filePath = path.join(__dirname, 'index.html');
      } else {
        // Remove query strings and decode URL
        const cleanUrl = decodeURIComponent(req.url.split('?')[0]);
        filePath = path.join(__dirname, cleanUrl);
      }

      // Check if file exists, try adding .html extension
      if (!fs.existsSync(filePath) && fs.existsSync(filePath + '.html')) {
        filePath += '.html';
      }

      // Security check - ensure path is within project directory
      const resolvedPath = path.resolve(filePath);
      const projectRoot = path.resolve(__dirname);
      if (!resolvedPath.startsWith(projectRoot)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      // Check if file exists
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('Not found: ' + req.url);
        return;
      }

      // Set content type
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'text/plain';
      res.setHeader('Content-Type', contentType);

      // Serve file
      const content = fs.readFileSync(filePath);
      res.writeHead(200);
      res.end(content);
    });

    server.listen(DASHBOARD_PORT, (err) => {
      if (err) {
        reject(err);
        return;
      }

      log(`✅ Dashboard Server running on port ${DASHBOARD_PORT}`, 'green');
      resolve(server);
    });
  });
}

async function main() {
  printBanner();

  try {
    // Start mock metrics server
    const mockServer = await startMockMetricsServer();

    // Wait a moment for the mock server to be ready
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Start dashboard server
    const dashboardServer = await startDashboardServer();

    console.log('');
    log('╔══════════════════════════════════════════════════════════════╗', 'magenta');
    log('║                     🎉 All Systems Ready!                    ║', 'magenta');
    log('╠══════════════════════════════════════════════════════════════╣', 'magenta');
    log(`║  📊 Metrics API:    http://localhost:${METRICS_PORT}/api/metrics          ║`, 'cyan');
    log(`║  🌐 Dashboard:       http://localhost:${DASHBOARD_PORT}                     ║`, 'cyan');
    log('║                                                              ║', 'magenta');
    log('║  Press Ctrl+C to stop both servers                           ║', 'yellow');
    log('╚══════════════════════════════════════════════════════════════╝', 'magenta');
    console.log('');

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('');
      log('📛 Shutting down servers...', 'yellow');

      mockServer.kill();
      dashboardServer.close(() => {
        log('✅ Servers stopped', 'green');
        process.exit(0);
      });
    });

    process.on('SIGTERM', () => {
      mockServer.kill();
      dashboardServer.close();
      process.exit(0);
    });

  } catch (error) {
    log(`❌ Error: ${error.message}`, 'red');
    console.error(error);
    process.exit(1);
  }
}

main();
