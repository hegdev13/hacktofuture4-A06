/**
 * Memory Module
 * In-memory learning store with TTL and pattern matching
 * Works without external database
 */

const config = require('../config');
const logger = require('../utils/logger');

class MemoryStore {
  constructor() {
    this.store = new Map();
    this.patterns = new Map();
    this.stats = {
      totalLearnings: 0,
      successfulFixes: 0,
      failedFixes: 0,
    };
    this.maxEntries = config.memory.maxEntries;
    this.ttlHours = config.memory.ttlHours;
  }

  /**
   * Store a learning event
   */
  storeLearning({
    issueType,
    problemSignature,
    fixType,
    target,
    success,
    beforeState,
    afterState,
    duration,
    metadata = {},
  }) {
    const timestamp = new Date().toISOString();
    const id = this.generateId();

    const entry = {
      id,
      timestamp,
      issueType,
      problemSignature: problemSignature || this.generateSignature(issueType, beforeState),
      fixType,
      target,
      success,
      beforeState: this.sanitizeState(beforeState),
      afterState: this.sanitizeState(afterState),
      duration,
      confidence: success ? 100 : 0,
      metadata,
      accessCount: 0,
      lastAccessed: timestamp,
    };

    // Store by ID
    this.store.set(id, entry);

    // Index by issue type for fast retrieval
    if (!this.patterns.has(issueType)) {
      this.patterns.set(issueType, new Set());
    }
    this.patterns.get(issueType).add(id);

    // Index by problem signature
    const signature = entry.problemSignature;
    if (!this.patterns.has(`sig:${signature}`)) {
      this.patterns.set(`sig:${signature}`, new Set());
    }
    this.patterns.get(`sig:${signature}`).add(id);

    // Update stats
    this.stats.totalLearnings++;
    if (success) {
      this.stats.successfulFixes++;
    } else {
      this.stats.failedFixes++;
    }

    // Cleanup if over limit
    if (this.store.size > this.maxEntries) {
      this.cleanup();
    }

    logger.debug('Learning stored', { id, issueType, fixType, success });

    return entry;
  }

  /**
   * Retrieve learnings by issue type
   */
  retrieveLearning(issueType, options = {}) {
    const { limit = 10, minConfidence = 0, includeFailed = false } = options;

    const ids = this.patterns.get(issueType) || new Set();
    const results = [];

    for (const id of ids) {
      const entry = this.store.get(id);
      if (!entry) continue;

      // Skip if expired
      if (this.isExpired(entry)) {
        this.store.delete(id);
        continue;
      }

      // Filter by confidence
      if (entry.confidence < minConfidence) continue;

      // Filter failed attempts
      if (!includeFailed && !entry.success) continue;

      // Update access metrics
      entry.accessCount++;
      entry.lastAccessed = new Date().toISOString();

      results.push({ ...entry });
    }

    // Sort by confidence (highest first) then by timestamp (most recent first)
    results.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return new Date(b.timestamp) - new Date(a.timestamp);
    });

    return results.slice(0, limit);
  }

  /**
   * Find similar past issues
   */
  findSimilarIssues(problemSignature, options = {}) {
    const { limit = 5, threshold = 0.7 } = options;

    const similar = [];

    for (const [id, entry] of this.store) {
      // Skip if expired
      if (this.isExpired(entry)) {
        this.store.delete(id);
        continue;
      }

      const similarity = this.calculateSimilarity(
        problemSignature,
        entry.problemSignature
      );

      if (similarity >= threshold) {
        similar.push({
          ...entry,
          similarity,
        });
      }
    }

    // Sort by similarity
    similar.sort((a, b) => b.similarity - a.similarity);

    return similar.slice(0, limit);
  }

  /**
   * Get recommended fix based on past learnings
   */
  getRecommendedFix(issueType, problemSignature) {
    // First try exact match
    const exactMatches = this.retrieveLearning(issueType, {
      minConfidence: config.memory.minConfidenceForLearning,
    });

    if (exactMatches.length > 0) {
      const successful = exactMatches.filter(e => e.success);
      if (successful.length > 0) {
        // Return most common successful fix
        const fixCounts = this.countFixTypes(successful);
        const recommended = Object.entries(fixCounts)
          .sort((a, b) => b[1] - a[1])[0];

        if (recommended) {
          return {
            fixType: recommended[0],
            confidence: successful[0].confidence * (recommended[1] / successful.length),
            basedOn: successful.length,
            reasoning: `Based on ${successful.length} successful fixes for similar ${issueType} issues`,
          };
        }
      }
    }

    // Try similar signatures
    const similar = this.findSimilarIssues(problemSignature, { threshold: 0.6 });
    const successfulSimilar = similar.filter(e => e.success);

    if (successfulSimilar.length > 0) {
      const fixCounts = this.countFixTypes(successfulSimilar);
      const recommended = Object.entries(fixCounts)
        .sort((a, b) => b[1] - a[1])[0];

      if (recommended) {
        return {
          fixType: recommended[0],
          confidence: successfulSimilar[0].similarity * 70,
          basedOn: successfulSimilar.length,
          reasoning: `Based on ${successfulSimilar.length} similar issues (signature match: ${Math.round(successfulSimilar[0].similarity * 100)}%)`,
        };
      }
    }

    return null;
  }

  /**
   * Update entry confidence
   */
  updateConfidence(id, success, feedback) {
    const entry = this.store.get(id);
    if (!entry) return null;

    if (success) {
      entry.confidence = Math.min(100, entry.confidence + 10);
      entry.success = true;
      this.stats.successfulFixes++;
    } else {
      entry.confidence = Math.max(0, entry.confidence - 20);
      if (entry.confidence === 0) {
        entry.success = false;
        this.stats.failedFixes++;
      }
    }

    entry.metadata.feedback = feedback;
    entry.lastAccessed = new Date().toISOString();

    return entry;
  }

  /**
   * Get learning statistics
   */
  getStats() {
    const issueTypes = Array.from(this.patterns.keys()).filter(k => !k.startsWith('sig:'));

    return {
      ...this.stats,
      storeSize: this.store.size,
      uniqueIssueTypes: issueTypes.length,
      successRate: this.stats.totalLearnings > 0
        ? (this.stats.successfulFixes / this.stats.totalLearnings * 100).toFixed(2)
        : 0,
    };
  }

  /**
   * Clear all memory
   */
  clear() {
    this.store.clear();
    this.patterns.clear();
    this.stats = {
      totalLearnings: 0,
      successfulFixes: 0,
      failedFixes: 0,
    };
    logger.info('Memory store cleared');
  }

  /**
   * Export all learnings
   */
  export() {
    return Array.from(this.store.values()).map(e => ({ ...e }));
  }

  /**
   * Import learnings
   */
  import(data) {
    if (!Array.isArray(data)) return false;

    data.forEach(entry => {
      if (entry.id && entry.timestamp) {
        this.store.set(entry.id, { ...entry });
        if (entry.issueType) {
          if (!this.patterns.has(entry.issueType)) {
            this.patterns.set(entry.issueType, new Set());
          }
          this.patterns.get(entry.issueType).add(entry.id);
        }
      }
    });

    logger.info(`Imported ${data.length} learnings`);
    return true;
  }

  /**
   * Generate unique ID
   */
  generateId() {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Generate problem signature from issue type and state
   */
  generateSignature(issueType, state) {
    if (!state) return issueType;

    const components = [issueType];

    if (state.pod) components.push(state.pod);
    if (state.status) components.push(state.status);
    if (state.severity) components.push(state.severity);

    // Create hash from components
    return components.join('|').toLowerCase().replace(/\s+/g, '_');
  }

  /**
   * Calculate similarity between signatures
   */
  calculateSimilarity(sig1, sig2) {
    if (sig1 === sig2) return 1.0;
    if (!sig1 || !sig2) return 0.0;

    const parts1 = sig1.split('|');
    const parts2 = sig2.split('|');

    const common = parts1.filter(p => parts2.includes(p));
    return common.length / Math.max(parts1.length, parts2.length);
  }

  /**
   * Count fix types in entries
   */
  countFixTypes(entries) {
    return entries.reduce((acc, entry) => {
      acc[entry.fixType] = (acc[entry.fixType] || 0) + 1;
      return acc;
    }, {});
  }

  /**
   * Check if entry is expired
   */
  isExpired(entry) {
    const entryDate = new Date(entry.timestamp);
    const expiryDate = new Date(entryDate.getTime() + this.ttlHours * 60 * 60 * 1000);
    return new Date() > expiryDate;
  }

  /**
   * Cleanup oldest entries
   */
  cleanup() {
    const entries = Array.from(this.store.entries());
    entries.sort((a, b) => new Date(a[1].timestamp) - new Date(b[1].timestamp));

    const toRemove = entries.slice(0, Math.floor(this.maxEntries * 0.1));
    toRemove.forEach(([id]) => {
      this.store.delete(id);
    });

    logger.debug(`Cleaned up ${toRemove.length} old entries`);
  }

  /**
   * Sanitize state for storage
   */
  sanitizeState(state) {
    if (!state) return null;
    // Remove sensitive data before storing
    const sanitized = { ...state };
    delete sanitized.passwords;
    delete sanitized.tokens;
    delete sanitized.secrets;
    return sanitized;
  }
}

// Export singleton
module.exports = new MemoryStore();
