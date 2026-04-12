"use client";

import React, { useEffect, useState } from "react";
import { MetricsProvider } from "@/lib/metricsContext";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "elevenlabs-convai": any;
    }
  }
  interface Window {
    clusterMetrics?: any;
    elevenlabsMetricsContext?: any;
  }
}

export function RootLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  const [metricsData, setMetricsData] = useState<any>(null);

  // Load metrics and make available globally
  useEffect(() => {
    const loadMetrics = async () => {
      try {
        const metricsUrl = process.env.NEXT_PUBLIC_METRICS_URL;
        if (!metricsUrl) {
          console.warn("NEXT_PUBLIC_METRICS_URL not configured");
          return;
        }

        const response = await fetch(metricsUrl);
        if (response.ok) {
          const data = await response.json();
          setMetricsData(data);
          
          // Store in window so ElevenLabs agent can access it
          window.clusterMetrics = data;
          window.elevenlabsMetricsContext = {
            cluster: data.cluster,
            resources: data.resources,
            timestamp: new Date().toISOString(),
          };
          
          console.log("✅ Metrics loaded and available to agent:", data.cluster);
        }
      } catch (error) {
        console.error("Failed to load metrics:", error);
      }
    };

    loadMetrics();

    // Refresh metrics every 30 seconds
    const interval = setInterval(loadMetrics, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    // Only load the script once - check if it's already loaded
    const scriptId = "elevenlabs-convai-script";
    
    if (!document.getElementById(scriptId)) {
      try {
        const script = document.createElement("script");
        script.id = scriptId;
        script.src = "https://unpkg.com/@elevenlabs/convai-widget-embed";
        script.async = true;
        script.type = "text/javascript";
        
        // Handle errors gracefully
        script.onerror = () => {
          console.error("Failed to load ElevenLabs widget script");
        };
        
        document.body.appendChild(script);
      } catch (error) {
        console.error("Error loading ElevenLabs script:", error);
      }
    }
  }, []);

  return (
    <MetricsProvider>
      {children}
      
      {/* ElevenLabs ConvAI Widget with metrics context available globally */}
      <div suppressHydrationWarning>
        {metricsData && (
          <div style={{ display: "none" }} id="metrics-context">
            {JSON.stringify(metricsData)}
          </div>
        )}
        <elevenlabs-convai agent-id="agent_7901kp0j3ecqfxy8wmj8dwskkejr"></elevenlabs-convai>
      </div>
    </MetricsProvider>
  );
}
