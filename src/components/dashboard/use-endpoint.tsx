"use client";

import { useEffect, useState } from "react";

const LS_KEY = "kubepulse.endpointId";

export function useSelectedEndpointId() {
  const [endpointId, setEndpointId] = useState<string | null>(null);

  useEffect(() => {
    // Load from localStorage on mount (after hydration)
    setEndpointId(localStorage.getItem(LS_KEY));

    // Listen for changes
    const sync = () => setEndpointId(localStorage.getItem(LS_KEY));
    window.addEventListener("kubepulse-endpoint", sync);
    window.addEventListener("storage", sync);

    return () => {
      window.removeEventListener("kubepulse-endpoint", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return endpointId;
}

