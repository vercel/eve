import { OTLPHttpJsonTraceExporter, registerOTel } from "@vercel/otel";
import { defineInstrumentation } from "eve/instrumentation";

/**
 * Shared instrumentation for e2e fixtures that export traces to Datadog.
 * Environments without `DD_API_KEY` keep telemetry enabled but do not
 * register an exporter.
 */
export default defineInstrumentation({
  recordInputs: false,
  recordOutputs: false,
  traceChannelRequests: true,
  events: {
    "step.started": () => ({
      runtimeContext: {
        "vercel.env": process.env.VERCEL_ENV ?? "",
      },
    }),
  },
  setup({ agentName }) {
    const datadogApiKey = process.env.DD_API_KEY?.trim();
    if (!datadogApiKey) {
      return;
    }

    registerOTel({
      serviceName: agentName,
      traceExporter: new OTLPHttpJsonTraceExporter({
        url: "https://vercel.integrations.otlp.datadoghq.com/v1/traces",
        headers: { "DD-API-KEY": datadogApiKey },
      }),
    });
  },
});
