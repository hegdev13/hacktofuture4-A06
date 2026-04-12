"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import {
  fetchEndpointsFromApi,
  getSelectedEndpointId,
  setSelectedEndpointId,
  type Endpoint,
} from "@/lib/endpoints-client";

export function EndpointPicker() {
  const router = useRouter();

  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    const init = async () => {
      try {
        const nextEndpoints = await fetchEndpointsFromApi();
        setEndpoints(nextEndpoints);
        setSelectedId(getSelectedEndpointId());
      } catch {
        setEndpoints([]);
      }
    };
    void init();
  }, []);

  useEffect(() => {
    const syncFromStorage = async () => {
      try {
        const nextEndpoints = await fetchEndpointsFromApi();
        const nextSelected = getSelectedEndpointId();
        setEndpoints(nextEndpoints);
        setSelectedId(nextSelected);
      } catch {
        setEndpoints([]);
      }
    };

    window.addEventListener("kubepulse-endpoint", syncFromStorage);
    window.addEventListener("storage", syncFromStorage);
    return () => {
      window.removeEventListener("kubepulse-endpoint", syncFromStorage);
      window.removeEventListener("storage", syncFromStorage);
    };
  }, []);

  useEffect(() => {
    if (!endpoints.length) return;
    const ls = getSelectedEndpointId();
    if (ls && endpoints.some((e) => e.id === ls)) {
      if (ls !== selectedId) {
        queueMicrotask(() => setSelectedId(ls));
      }
      return;
    }
    const next = endpoints[0].id;
    setSelectedEndpointId(next);
    queueMicrotask(() => setSelectedId(next));
    router.refresh();
  }, [endpoints, router, selectedId]);

  if (!endpoints.length) {
    return (
      <a
        className="text-xs font-semibold text-primary-strong hover:text-primary"
        href="/dashboard/setup"
      >
        Add an endpoint
      </a>
    );
  }

  return (
    <div className="relative">
      <select
        value={selectedId}
        onChange={(e) => {
          const id = e.target.value;
          setSelectedEndpointId(id);
          setSelectedId(id);
          router.refresh();
        }}
        className="appearance-none rounded-full border border-[#e0d6c6] bg-[#fffaf2] px-4 py-2 pr-9 text-xs font-medium text-[#34424d] shadow-[0_8px_16px_rgba(70,86,94,0.08)] focus:outline-none focus:ring-2 focus:ring-primary/35"
      >
        {endpoints.map((ep) => (
          <option key={ep.id} value={ep.id}>
            {ep.name}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
    </div>
  );
}

