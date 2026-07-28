import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel";
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      traceExporter: new OTLPHttpProtoTraceExporter({
        url: "https://api.honeycomb.io/v1/traces",
        headers: { "x-honeycomb-team": process.env.HONEYCOMB_API_KEY! },
      }),
    }),
});
