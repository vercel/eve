import { OTLPHttpJsonTraceExporter } from "@vercel/otel";
import { otelIntegration } from "eve/instrumentation/otel";

/**
 * Shared instrumentation for e2e fixtures that export traces to Datadog.
 * Environments without `DD_API_KEY` keep telemetry enabled but do not
 * register an exporter.
 */
const datadogApiKey = process.env.DD_API_KEY?.trim();

export default otelIntegration({
  ...(datadogApiKey
    ? {
        traceExporter: new OTLPHttpJsonTraceExporter({
          url: "https://vercel.integrations.otlp.datadoghq.com/v1/traces",
          headers: { "DD-API-KEY": datadogApiKey },
        }),
      }
    : {}),
  runtimeContext: () => ({
    "vercel.env": process.env.VERCEL_ENV ?? "",
  }),
});
