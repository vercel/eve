import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel";
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      traceExporter: new OTLPHttpProtoTraceExporter({
        url: process.env.DATADOG_OTLP_TRACES_ENDPOINT!,
        headers: { "dd-api-key": process.env.DD_API_KEY! },
      }),
    }),
});
