/**
 * Mock Demo Launcher
 * Run this to start the interactive mock environment
 */

import MockDashboardServer from '../dashboard/mock-server.js';

console.log('🎮 ===========================================');
console.log('🎮  Self-Healing System - Interactive Mock Mode');
console.log('🎮 ===========================================\n');

console.log('Features:');
console.log('  • Toggle container health manually');
console.log('  • Watch RCA trace failure chains in real-time');
console.log('  • Simulate cascading failures');
console.log('  • Switch between different scenarios');
console.log('  • See dynamic flowchart with animations\n');

const PORT = 5555;
const server = new MockDashboardServer(PORT);
server.start();

console.log(`\n📖 How to use:`);
console.log(`  1. Open http://localhost:${PORT} in your browser`);
console.log('  2. Choose a scenario (Cascading, Isolated, Multi-root, Deep, Circular)');
console.log('  3. Click "Break" on any pod to make it fail');
console.log('  4. Watch the RCA flowchart update automatically!');
console.log('  5. Try "Cascade" to see failures propagate');
console.log('  6. Use "Heal All" to reset everything\n');

console.log('💡 Pro tip: Start with "Cascading Failure" scenario and break the database!\n');
