"use client";

export type Endpoint = {
  id: string;
  name: string;
  ngrok_url: string;
  created_at: string;
};

export const SELECTED_ENDPOINT_KEY = "kubepulse.endpointId";

export async function fetchEndpointsFromApi(): Promise<Endpoint[]> {
  const res = await fetch("/api/endpoints", { cache: "no-store" });
  const data = (await res.json()) as { endpoints?: Endpoint[]; error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return Array.isArray(data.endpoints) ? data.endpoints : [];
}

export function getSelectedEndpointId() {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(SELECTED_ENDPOINT_KEY) || "";
}

export function setSelectedEndpointId(endpointId: string) {
  localStorage.setItem(SELECTED_ENDPOINT_KEY, endpointId);
  window.dispatchEvent(new Event("kubepulse-endpoint"));
}

export async function readSelectedEndpoint(): Promise<Endpoint | null> {
  const selectedId = getSelectedEndpointId();
  if (!selectedId) return null;
  const endpoints = await fetchEndpointsFromApi();
  return endpoints.find((ep) => ep.id === selectedId) ?? null;
}
