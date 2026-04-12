"use client";

import { useSyncExternalStore } from "react";

const LS_KEY = "kubepulse.endpointId";

export function useSelectedEndpointId() {
  return useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window === "undefined") return () => {};
      const sync = () => onStoreChange();
      window.addEventListener("kubepulse-endpoint", sync);
      window.addEventListener("storage", sync);
      return () => {
        window.removeEventListener("kubepulse-endpoint", sync);
        window.removeEventListener("storage", sync);
      };
    },
    () => {
      if (typeof window === "undefined") return null;
      return localStorage.getItem(LS_KEY);
    },
    () => null,
  );
}

