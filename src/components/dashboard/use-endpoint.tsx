"use client";

import { useEffect, useState } from "react";

const LS_KEY = "kubepulse.endpointId";

export function useSelectedEndpointId() {
  const [endpointId, setEndpointId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(LS_KEY);
  });

  useEffect(() => {
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

