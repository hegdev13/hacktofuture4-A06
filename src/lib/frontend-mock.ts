"use client";

export type Endpoint = {
  id: string;
  name: string;
  ngrok_url: string;
  created_at: string;
};

export type SnapshotRow = {
  id: string;
  endpoint_id: string;
  pod_name: string;
  namespace: string;
  status: string;
  cpu_usage: number | null;
  memory_usage: number | null;
  restart_count: number;
  timestamp: string;
};

const ENDPOINTS_KEY = "kubepulse.endpoints";

const PODS = [
  "frontend",
  "cartservice",
  "checkoutservice",
  "productcatalogservice",
  "currencyservice",
  "paymentservice",
  "shippingservice",
  "recommendationservice",
];

export function loadEndpoints(): Endpoint[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(ENDPOINTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Endpoint[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveEndpoint(name: string, ngrok_url: string) {
  if (typeof window === "undefined") return;
  const next: Endpoint = {
    id: crypto.randomUUID(),
    name,
    ngrok_url,
    created_at: new Date().toISOString(),
  };
  const list = [next, ...loadEndpoints()];
  localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(list));
  if (!localStorage.getItem("kubepulse.endpointId")) {
    localStorage.setItem("kubepulse.endpointId", next.id);
  }
}

export function deleteEndpoint(endpointId: string) {
  if (typeof window === "undefined") return;
  const next = loadEndpoints().filter((ep) => ep.id !== endpointId);
  localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(next));

  const selectedId = localStorage.getItem("kubepulse.endpointId");
  if (selectedId === endpointId) {
    if (next.length) {
      localStorage.setItem("kubepulse.endpointId", next[0].id);
    } else {
      localStorage.removeItem("kubepulse.endpointId");
    }
  }
}

const cache = new Map<string, SnapshotRow[]>();

function randomStatus() {
  const r = Math.random();
  if (r < 0.84) return "Running";
  if (r < 0.93) return "Pending";
  if (r < 0.97) return "CrashLoopBackOff";
  return "Error";
}

export function initialSnapshots(endpointId: string): SnapshotRow[] {
  if (cache.has(endpointId)) return cache.get(endpointId)!;
  const now = Date.now();
  const rows: SnapshotRow[] = [];
  for (let t = 0; t < 40; t += 1) {
    for (const pod of PODS) {
      const status = randomStatus();
      rows.push({
        id: crypto.randomUUID(),
        endpoint_id: endpointId,
        pod_name: `${pod}-7d5c6f9c-${Math.floor(1000 + Math.random() * 8999)}`,
        namespace: "default",
        status,
        cpu_usage: Number((0.08 + Math.random() * 1.6).toFixed(3)),
        memory_usage: Math.floor(40_000_000 + Math.random() * 700_000_000),
        restart_count: status === "Running" ? Math.floor(Math.random() * 2) : Math.floor(2 + Math.random() * 5),
        timestamp: new Date(now - (40 - t) * 5000).toISOString(),
      });
    }
  }
  cache.set(endpointId, rows);
  return rows;
}

export function tickSnapshots(endpointId: string): SnapshotRow[] {
  const prev = initialSnapshots(endpointId);
  const nextTs = new Date().toISOString();
  const fresh = PODS.map((pod) => {
    const status = randomStatus();
    return {
      id: crypto.randomUUID(),
      endpoint_id: endpointId,
      pod_name: `${pod}-7d5c6f9c-${Math.floor(1000 + Math.random() * 8999)}`,
      namespace: "default",
      status,
      cpu_usage: Number((0.08 + Math.random() * 1.6).toFixed(3)),
      memory_usage: Math.floor(40_000_000 + Math.random() * 700_000_000),
      restart_count: status === "Running" ? Math.floor(Math.random() * 2) : Math.floor(2 + Math.random() * 6),
      timestamp: nextTs,
    };
  });
  const merged = [...fresh, ...prev].slice(0, 1000);
  cache.set(endpointId, merged);
  return merged;
}

