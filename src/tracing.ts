import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

declare global {
  // eslint-disable-next-line no-var
  var __otelSdkStarted: boolean | undefined;
}

if (!globalThis.__otelSdkStarted) {
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    "http://localhost:4318/v1/traces";
  const serviceName = process.env.OTEL_SERVICE_NAME || "h24app-nextjs";

  const exporter = new OTLPTraceExporter({ url: endpoint });
  const sdk = new NodeSDK({
    traceExporter: exporter,
    instrumentations: [getNodeAutoInstrumentations()],
    serviceName,
  });

  try {
    const started = sdk.start();
    if (started && typeof (started as Promise<void>).then === "function") {
      (started as Promise<void>)
        .then(() => {
          console.log(`[otel] Tracing initialized for ${serviceName} -> ${endpoint}`);
        })
        .catch((err) => {
          console.error("[otel] Error initializing tracing", err);
        });
    } else {
      console.log(`[otel] Tracing initialized for ${serviceName} -> ${endpoint}`);
    }
  } catch (err) {
    console.error("[otel] Error initializing tracing", err);
  }

  process.on("SIGTERM", () => {
    sdk
      .shutdown()
      .then(() => {
        console.log("[otel] Tracing terminated");
      })
      .catch((err) => {
        console.error("[otel] Error terminating tracing", err);
      })
      .finally(() => {
        process.exit(0);
      });
  });

  globalThis.__otelSdkStarted = true;
}
