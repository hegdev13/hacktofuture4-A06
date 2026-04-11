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

  const [endpoints, setEndpoints] = useState<Endpoint[]>(() => {
    if (typeof window === "undefined") return [];
    return loadEndpoints();
  });
  const [selectedId, setSelectedId] = useState(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(LS_KEY) || "";
  });

  useEffect(() => {
    const syncFromStorage = () => {
      const nextEndpoints = loadEndpoints();
      const nextSelected = localStorage.getItem(LS_KEY) || "";
      setEndpoints(nextEndpoints);
      setSelectedId(nextSelected);
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
    const ls = localStorage.getItem(LS_KEY);
    if (ls && endpoints.some((e) => e.id === ls)) {
      if (ls !== selectedId) {
        queueMicrotask(() => setSelectedId(ls));
      }
      return;
    }
    const next = endpoints[0].id;
    localStorage.setItem(LS_KEY, next);
    queueMicrotask(() => setSelectedId(next));
    window.dispatchEvent(new Event("kubepulse-endpoint"));
    router.refresh();
  }, [endpoints, router, selectedId]);

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

