#!/usr/bin/env node

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function toNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function usage() {
  console.log("Usage:");
  console.log("  node scripts/push-cpu-pattern.cjs --endpoint <uuid> --secret <secret> [options]");
  console.log("");
  console.log("Required:");
  console.log("  --endpoint   Endpoint UUID from your app");
  console.log("  --secret     METRICS_POLL_SECRET");
  console.log("");
  console.log("Options:");
  console.log("  --base       API base URL (default: http://localhost:3000)");
  console.log("  --profile    high | low | wave (default: high)");
  console.log("  --duration   Total seconds to push (default: 120)");
  console.log("  --interval   Seconds between pushes (default: 2)");
  console.log("  --pods       Number of synthetic pods (default: 6)");
  console.log("  --namespace  Namespace label (default: default)");
  console.log("");
  console.log("Examples:");
  console.log("  node scripts/push-cpu-pattern.cjs --endpoint <id> --secret <secret> --profile high --duration 90");
  console.log("  node scripts/push-cpu-pattern.cjs --endpoint <id> --secret <secret> --profile low --duration 90");
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function cpuFor(profile, t, idx) {
  if (profile === "low") {
    return clamp(0.08 + 0.03 * Math.sin((t + idx) / 4), 0.04, 0.2);
  }
  if (profile === "wave") {
    return clamp(0.45 + 0.35 * Math.sin((t + idx) / 3), 0.08, 0.95);
  }
  return clamp(0.82 + 0.1 * Math.sin((t + idx) / 5), 0.55, 0.98);
}

function memoryFor(profile, t, idx) {
  const base = profile === "low" ? 260 : profile === "wave" ? 520 : 900;
  const swing = profile === "low" ? 70 : profile === "wave" ? 220 : 280;
  return Math.round((base + swing * Math.sin((t + idx) / 6)) * 1024 * 1024);
}

async function pushOnce({ base, endpointId, secret, profile, podCount, namespace, tick }) {
  const now = new Date().toISOString();
  const metrics = [];

  for (let i = 0; i < podCount; i += 1) {
    const pod = `loadtest-pod-${i + 1}`;
    const cpu = cpuFor(profile, tick, i);
    const memory = memoryFor(profile, tick, i);

    metrics.push({
      metric_name: "cpu_usage",
      labels: { pod, namespace, source: "synthetic" },
      value: cpu,
      timestamp: now,
    });

    metrics.push({
      metric_name: "memory_usage",
      labels: { pod, namespace, source: "synthetic" },
      value: memory,
      timestamp: now,
    });
  }

  const res = await fetch(`${base}/api/metrics/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-kubepulse-secret": secret,
    },
    body: JSON.stringify({
      endpoint_id: endpointId,
      metrics,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) {
    throw new Error(`Ingest failed (${res.status}): ${JSON.stringify(body)}`);
  }

  return body;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help === "true" || args.h === "true") {
    usage();
    process.exit(0);
  }

  const endpointId = args.endpoint || process.env.KUBEPULSE_ENDPOINT_ID;
  const secret = args.secret || process.env.METRICS_POLL_SECRET;

  if (!endpointId || !secret) {
    usage();
    throw new Error("Missing --endpoint or --secret");
  }

  const base = args.base || process.env.KUBEPULSE_BASE_URL || "http://localhost:3000";
  const profile = ["high", "low", "wave"].includes(args.profile) ? args.profile : "high";
  const durationSec = toNumber(args.duration, 120);
  const intervalSec = Math.max(1, toNumber(args.interval, 2));
  const podCount = Math.max(1, toNumber(args.pods, 6));
  const namespace = args.namespace || "default";

  const iterations = Math.max(1, Math.floor(durationSec / intervalSec));

  console.log(`[sim] profile=${profile} duration=${durationSec}s interval=${intervalSec}s pods=${podCount}`);
  console.log(`[sim] posting to ${base}/api/metrics/ingest for endpoint ${endpointId}`);

  for (let i = 0; i < iterations; i += 1) {
    const result = await pushOnce({
      base,
      endpointId,
      secret,
      profile,
      podCount,
      namespace,
      tick: i,
    });

    const pct = Math.round(((i + 1) / iterations) * 100);
    process.stdout.write(`\r[sim] ${pct}%  inserted=${result.inserted ?? "?"}     `);

    if (i < iterations - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
    }
  }

  process.stdout.write("\n");
  console.log("[sim] done");
}

main().catch((err) => {
  console.error("[sim] error:", err.message || err);
  process.exit(1);
});
