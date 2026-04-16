/**
 * Dependency Extractor
 * Extracts service dependencies from:
 * 1. Environment variables in pod specs
 * 2. ConfigMaps
 * 3. Logs (pattern matching)
 */

class DependencyExtractor {
  /**
   * Extract dependencies from environment variables
   * Looks for URLs, service names, hosts, etc.
   */
  static extractFromEnv(envVars) {
    const dependencies = new Set();

    for (const key in envVars) {
      const value = envVars[key];

      // Match URLs like http://service-name:port or https://api.example.com
      const urlMatches = value.match(/https?:\/\/([a-zA-Z0-9._\-]+)/g);
      if (urlMatches) {
        urlMatches.forEach((url) => {
          const hostname = new URL(url).hostname;
          const serviceName = hostname.split(".")[0]; // get service name before domain
          if (serviceName && serviceName !== "localhost" && serviceName !== "127.0.0.1") {
            dependencies.add(serviceName);
          }
        });
      }

      // Match service names in common patterns
      if (
        key.includes("SERVICE") ||
        key.includes("HOST") ||
        key.includes("SERVER") ||
        key.includes("BACKEND") ||
        key.includes("DATABASE")
      ) {
        // Value might be a service name directly
        if (typeof value === "string" && /^[a-z0-9][a-z0-9\-]*[a-z0-9]$/i.test(value)) {
          dependencies.add(value.toLowerCase());
        }
      }
    }

    return Array.from(dependencies);
  }

  /**
   * Extract dependencies from ConfigMap data
   * Looks for service references, connection strings, etc.
   */
  static extractFromConfigMap(configData) {
    const dependencies = new Set();

    for (const key in configData) {
      const value = configData[key];

      if (typeof value !== "string") continue;

      // Extract URLs
      const urlMatches = value.match(/https?:\/\/([a-zA-Z0-9._\-]+)/g);
      if (urlMatches) {
        urlMatches.forEach((url) => {
          const hostname = new URL(url).hostname;
          const serviceName = hostname.split(".")[0];
          if (serviceName && serviceName !== "localhost") {
            dependencies.add(serviceName);
          }
        });
      }

      // Extract connection strings (PostgreSQL: "host=service-name dbname=...")
      const connStringMatches = value.match(/host=([a-zA-Z0-9._\-]+)/g);
      if (connStringMatches) {
        connStringMatches.forEach((match) => {
          const serviceName = match.replace("host=", "");
          dependencies.add(serviceName.toLowerCase());
        });
      }

      // Extract Redis patterns
      const redisMatches = value.match(/redis:\/\/([a-zA-Z0-9._\-]+)/g);
      if (redisMatches) {
        redisMatches.forEach((match) => {
          const serviceName = match.replace("redis://", "");
          dependencies.add(serviceName.toLowerCase());
        });
      }
    }

    return Array.from(dependencies);
  }

  /**
   * Extract dependencies from logs using pattern matching
   * Looks for patterns like "connecting to X" or "cannot reach Y"
   */
  static extractFromLogs(logs) {
    const dependencies = new Set();

    const patterns = [
      /connecting to ([a-zA-Z0-9._\-:]+)/gi,
      /failed to connect to ([a-zA-Z0-9._\-:]+)/gi,
      /upstream service ([a-zA-Z0-9._\-]+)/gi,
      /calling ([a-zA-Z0-9._\-]+)/gi,
      /contacting ([a-zA-Z0-9._\-]+)/gi,
      /request to ([a-zA-Z0-9._\-:]+)/gi,
      /querying ([a-zA-Z0-9._\-]+)/gi,
    ];

    for (const pattern of patterns) {
      const matches = logs.matchAll(pattern);
      for (const match of matches) {
        let serviceName = match[1];
        // Remove port if present
        if (serviceName.includes(":")) {
          serviceName = serviceName.split(":")[0];
        }
        if (serviceName && serviceName !== "localhost" && serviceName !== "127.0.0.1") {
          dependencies.add(serviceName.toLowerCase());
        }
      }
    }

    return Array.from(dependencies);
  }

  /**
   * Extract dependencies from all sources and merge
   */
  static extractAll(pod) {
    const fromEnv = this.extractFromEnv(pod.env || {});
    const fromConfig = this.extractFromConfigMap(pod.configMap || {});
    const fromLogs = this.extractFromLogs(pod.logs || "");

    // Merge and deduplicate
    const all = new Set([...fromEnv, ...fromConfig, ...fromLogs]);

    return {
      env: fromEnv,
      configMap: fromConfig,
      logs: fromLogs,
      merged: Array.from(all),
    };
  }

  /**
   * Build dependency graph from a list of pods
   */
  static buildGraphFromPods(pods, graph) {
    for (const pod of pods) {
      const podId = pod.id || pod.name;
      graph.addNode(podId, pod.name || podId, { pod });

      const deps = this.extractAll(pod).merged;

      for (const dep of deps) {
        // Try to find the dependency in the pods list
        const depPod = pods.find(
          (p) =>
            (p.id || p.name).toLowerCase() === dep.toLowerCase() ||
            (p.name || p.id)
              .toLowerCase()
              .includes(dep.toLowerCase())
        );

        if (depPod) {
          const depId = depPod.id || depPod.name;
          const success = graph.addEdge(podId, depId, { source: "extracted" });
          if (!success && dep !== podId) {
            console.warn(`Could not add edge ${podId} → ${depId}`);
          }
        }
      }
    }

    return graph;
  }
}

module.exports = DependencyExtractor;
