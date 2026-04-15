"use client";

import React, { createContext, useContext, useState, useCallback, useEffect } from "react";

interface MetricsContextType {
  metricsUrl: string;
  setMetricsUrl: (url: string) => void;
  metrics: any;
  connectionStatus: "idle" | "loading" | "connected" | "error";
  fetchMetrics: () => Promise<void>;
}

const MetricsContext = createContext<MetricsContextType | undefined>(undefined);

export const MetricsProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [metricsUrl, setMetricsUrl] = useState<string>("");
  const [metrics, setMetrics] = useState<any>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    "idle" | "loading" | "connected" | "error"
  >("idle");
  const [isLoaded, setIsLoaded] = useState(false);

  // Load environment variable on client side only
  useEffect(() => {
    const envUrl = process.env.NEXT_PUBLIC_METRICS_URL;
    if (envUrl && !metricsUrl) {
      setMetricsUrl(envUrl);
    }
    setIsLoaded(true);
  }, [metricsUrl]);

  const fetchMetrics = useCallback(async () => {
    if (!metricsUrl) {
      setConnectionStatus("idle");
      return;
    }

    setConnectionStatus("loading");
    try {
      const response = await fetch(metricsUrl);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      setMetrics(data);
      setConnectionStatus("connected");
      console.log("✅ Metrics loaded successfully", data);
    } catch (error) {
      console.error("Metrics fetch error:", error);
      setConnectionStatus("error");
      setMetrics(null);
    }
  }, [metricsUrl]);

  // Fetch metrics on URL change
  useEffect(() => {
    if (isLoaded && metricsUrl) {
      fetchMetrics();
      const interval = setInterval(fetchMetrics, 30000); // Refresh every 30s
      return () => clearInterval(interval);
    }
  }, [metricsUrl, isLoaded, fetchMetrics]);

  if (!isLoaded) {
    return <>{children}</>;
  }

  return (
    <MetricsContext.Provider
      value={{ metricsUrl, setMetricsUrl, metrics, connectionStatus, fetchMetrics }}
    >
      {children}
    </MetricsContext.Provider>
  );
};

export const useMetricsContext = () => {
  const context = useContext(MetricsContext);
  if (!context) {
    // Return a default context if not wrapped
    return {
      metricsUrl: process.env.NEXT_PUBLIC_METRICS_URL || "",
      setMetricsUrl: () => {},
      metrics: null,
      connectionStatus: "idle" as const,
      fetchMetrics: async () => {},
    };
  }
  return context;
};
