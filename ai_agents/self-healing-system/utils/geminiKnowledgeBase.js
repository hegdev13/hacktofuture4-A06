/**
 * Gemini Knowledge Base Client
 * Queries Gemini for remediation guidance using current RCA context.
 */

const https = require('https');
const config = require('../config');
const logger = require('./logger');

class GeminiKnowledgeBase {
  constructor() {
    this.enabled = config.knowledgeBase.enabled;
    this.provider = config.knowledgeBase.provider;
    this.apiKey = config.knowledgeBase.apiKey;
    this.model = config.knowledgeBase.model;
    this.timeoutMs = config.knowledgeBase.timeoutMs;
  }

  isAvailable() {
    return this.enabled && this.provider === 'gemini' && Boolean(this.apiKey);
  }

  async getRemediationGuidance(context) {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const prompt = this.buildPrompt(context);
      const raw = await this.callGemini(prompt);
      const parsed = this.parseJsonFromText(raw);

      if (!parsed || !parsed.recommendation) {
        return null;
      }

      const recommendation = {
        strategy: parsed.recommendation.strategy,
        target: parsed.recommendation.target || context.rootCause,
        confidence: Number(parsed.recommendation.confidence || 0),
        reason: parsed.recommendation.reason || 'Gemini recommendation',
      };

      logger.info(
        `Gemini KB recommendation: ${recommendation.strategy} on ${recommendation.target} (${recommendation.confidence}%)`
      );

      return recommendation;
    } catch (error) {
      logger.warn(`Gemini KB lookup failed: ${error.message}`);
      return null;
    }
  }

  buildPrompt(context) {
    const safeContext = {
      rootCause: context.rootCause,
      rootCauseType: context.rootCauseType,
      failureChain: context.failureChain || [],
      chainDetails: context.chainDetails || [],
      affectedResources: context.affectedResources || [],
      availableStrategies: config.execution.strategies,
      dryRun: config.execution.dryRun,
    };

    return [
      'You are a Kubernetes SRE remediation assistant.',
      'Choose exactly one safest remediation strategy from availableStrategies.',
      'Prefer minimal blast radius and fast recovery.',
      'Respond with valid JSON only and no markdown.',
      'JSON schema:',
      '{',
      '  "recommendation": {',
      '    "strategy": "restart_pod|scale_up|scale_down|rollback|restart_dependency_first|cordon_node|drain_node",',
      '    "target": "string",',
      '    "confidence": 0-100,',
      '    "reason": "string"',
      '  }',
      '}',
      `Context: ${JSON.stringify(safeContext)}`,
    ].join('\n');
  }

  callGemini(prompt) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          topK: 20,
          topP: 0.8,
          maxOutputTokens: 512,
        },
      });

      const path = `/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

      const req = https.request(
        {
          hostname: 'generativelanguage.googleapis.com',
          method: 'POST',
          path,
          timeout: this.timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new Error(`Gemini API HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
            }

            try {
              const parsed = JSON.parse(data);
              const text =
                parsed?.candidates?.[0]?.content?.parts
                  ?.map((p) => p.text)
                  .filter(Boolean)
                  .join('\n') || '';

              if (!text) {
                return reject(new Error('Gemini returned empty response'));
              }

              resolve(text);
            } catch (error) {
              reject(new Error(`Failed to parse Gemini response: ${error.message}`));
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Gemini request timed out after ${this.timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }

  parseJsonFromText(text) {
    const trimmed = String(text || '').trim();

    // Direct JSON response
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      // continue
    }

    // Extract first JSON object block
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

module.exports = new GeminiKnowledgeBase();
