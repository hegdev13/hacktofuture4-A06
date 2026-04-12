"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { loadEndpoints } from "@/lib/frontend-mock";

type Endpoint = {
  id: string;
  name: string;
  ngrok_url: string;
};

const LS_KEY = "kubepulse.endpointId";

export function EndpointPicker() {
  const router = useRouter();

  // Start with uninitialized state to allow hydration to match
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");

  // Hydrate from localStorage after mounting
  useEffect(() => {
    const nextEndpoints = loadEndpoints();
    const nextSelected = localStorage.getItem(LS_KEY) || "";
    setEndpoints(nextEndpoints);
    setSelectedId(nextSelected);

    const syncFromStorage = () => {
      const updated = loadEndpoints();
      const selected = localStorage.getItem(LS_KEY) || "";
      setEndpoints(updated);
      setSelectedId(selected);
    };

    window.addEventListener("kubepulse-endpoint", syncFromStorage);
    window.addEventListener("storage", syncFromStorage);

    return () => {
      window.removeEventListener("kubepulse-endpoint", syncFromStorage);
      window.removeEventListener("storage", syncFromStorage);
    };
  }, []);

  // Auto-select first endpoint if none selected
  useEffect(() => {
    if (!endpoints?.length || selectedId) return;

    const firstId = endpoints[0].id;
    localStorage.setItem(LS_KEY, firstId);
    setSelectedId(firstId);
    window.dispatchEvent(new Event("kubepulse-endpoint"));
    router.refresh();
  }, [endpoints, selectedId, router]);

  // Show loading state during hydration
  if (endpoints === null) {
    return <div className="text-xs text-zinc-400">Loading...</div>;
  }

  if (!endpoints.length) {
    return (
      <a
        className="text-xs text-indigo-300 hover:underline"
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
          localStorage.setItem(LS_KEY, id);
          setSelectedId(id);
          window.dispatchEvent(new Event("kubepulse-endpoint"));
          router.refresh();
        }}
        className="appearance-none text-xs rounded-md border border-white/10 bg-white/5 px-3 py-2 pr-8 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
      >
        {endpoints.map((ep) => (
          <option key={ep.id} value={ep.id}>
            {ep.name}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
    </div>
  );
}

