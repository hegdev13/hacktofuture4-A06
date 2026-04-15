/**
 * Logger Utility
 * Timeline-based logging for the self-healing system
 */

const config = require('../config');

class Logger {
  constructor() {
    this.timeline = [];
    this.enableColors = config.logging.enableColors;
    this.levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    };
    this.currentLevel = this.levels[config.logging.level] || 1;
  }

  /**
   * Format timestamp for timeline
   */
  formatTime(date = new Date()) {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return `[${hours}:${minutes}:${seconds}]`;
  }

  /**
   * Color codes for terminal output
   */
  colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
  };

  /**
   * Apply color to text
   */
  colorize(text, color) {
    if (!this.enableColors) return text;
    return `${this.colors[color]}${text}${this.colors.reset}`;
  }

  /**
   * Log a message with timestamp
   */
  log(level, message, metadata = {}) {
    if (this.levels[level] < this.currentLevel) return;

    const timestamp = this.formatTime();
    const entry = {
      timestamp: new Date().toISOString(),
      displayTime: timestamp,
      level,
      message,
      metadata,
    };

    this.timeline.push(entry);

    // Console output with colors
    const colorMap = {
      debug: 'dim',
      info: 'cyan',
      warn: 'yellow',
      error: 'red',
    };

    const levelLabel = this.colorize(level.toUpperCase().padEnd(5), colorMap[level] || 'reset');
    const timeStr = this.colorize(timestamp, 'dim');

    let output = `${timeStr} ${levelLabel} ${message}`;

    if (Object.keys(metadata).length > 0) {
      output += ` ${this.colorize(JSON.stringify(metadata), 'dim')}`;
    }

    console.log(output);
  }

  /**
   * Timeline logging methods
   */
  timelineEvent(eventType, description, metadata = {}) {
    const timestamp = this.formatTime();

    const eventColors = {
      issue: 'red',
      analysis: 'yellow',
      rca: 'magenta',
      fix: 'blue',
      success: 'green',
      retry: 'cyan',
      error: 'red',
    };

    const color = eventColors[eventType] || 'reset';
    const timeStr = this.colorize(timestamp, 'dim');
    const typeStr = this.colorize(`[${eventType.toUpperCase()}]`, color);

    console.log(`${timeStr} ${typeStr} ${description}`);

    this.timeline.push({
      timestamp: new Date().toISOString(),
      displayTime: timestamp,
      type: eventType,
      description,
      metadata,
    });
  }

  debug(message, metadata) { this.log('debug', message, metadata); }
  info(message, metadata) { this.log('info', message, metadata); }
  warn(message, metadata) { this.log('warn', message, metadata); }
  error(message, metadata) { this.log('error', message, metadata); }

  /**
   * Log system startup banner
   */
  banner() {
    const banner = `
╔══════════════════════════════════════════════════════════════╗
║     AGENTIC KUBERNETES SELF-HEALING SYSTEM v1.0.0            ║
║                                                              ║
║  Modules: Observer | RCA | Executioner | Memory             ║
╚══════════════════════════════════════════════════════════════╝
    `;
    console.log(this.colorize(banner, 'bright'));
  }

  /**
   * Get full timeline
   */
  getTimeline() {
    return [...this.timeline];
  }

  /**
   * Export timeline as formatted string
   */
  exportTimeline() {
    return this.timeline.map(entry =>
      `${entry.displayTime} [${entry.type?.toUpperCase() || entry.level.toUpperCase()}] ${entry.description || entry.message}`
    ).join('\n');
  }

  /**
   * Clear timeline
   */
  clear() {
    this.timeline = [];
  }
}

// Singleton instance
module.exports = new Logger();
