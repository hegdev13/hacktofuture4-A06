"use client";

import { useEffect, useMemo, useState } from "react";
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

  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [loading, setLoading] = useState(false);

  const selectedId = useMemo(() => {
    return (typeof window !== "undefined" ? localStorage.getItem(LS_KEY) : null) || "";
  }, []);

  useEffect(() => {
    setLoading(true);
    setEndpoints(loadEndpoints());
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!endpoints.length) return;
    const ls = localStorage.getItem(LS_KEY);
    if (ls && endpoints.some((e) => e.id === ls)) return;
    localStorage.setItem(LS_KEY, endpoints[0].id);
    router.refresh();
  }, [endpoints, router]);

  if (loading) {
    return (
      <div className="text-xs text-zinc-400 border border-white/10 bg-white/5 rounded-md px-3 py-2">
        Loading endpoints…
      </div>
    );
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

