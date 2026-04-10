"use client";

import { useMemo } from "react";

const LS_KEY = "kubepulse.endpointId";

export function useSelectedEndpointId() {
  return useMemo(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(LS_KEY);
  }, []);
}

