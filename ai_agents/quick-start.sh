#!/bin/bash

# Quick Start Script for Self-Healing System with Live Metrics
# Usage: ./quick-start.sh [ngrok-url]

set -e

clear

echo "🚀 Self-Healing System - Quick Start"
echo "═════════════════════════════════════════════"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js >= 14.0.0"
    exit 1
fi

echo "✅ Node.js $(node --version)"

# Use provided ngrok URL or default
NGROK_URL="${1:-https://refocus-cement-spud.ngrok-free.dev/pods}"

echo ""
echo "📊 Configuration:"
echo "   Ngrok URL: $NGROK_URL"
echo "   Dashboard: http://localhost:3456"
echo "   Mode: Dry-run (safe mode - won't execute real fixes)"
echo ""
echo "═════════════════════════════════════════════"
echo ""

# Start the system
export NGROK_URL="$NGROK_URL"
export DASHBOARD_PORT=3456
export DRY_RUN=true

echo "🎯 Starting system..."
echo ""
echo "📡 Dashboard will be available at: http://localhost:3456"
echo "💡 Tip: After opening the dashboard, paste your ngrok URL and click 'Connect Metrics'"
echo ""
echo "Press Ctrl+C to stop the system"
echo ""
echo "═════════════════════════════════════════════"
echo ""

node start-with-live-metrics.js
