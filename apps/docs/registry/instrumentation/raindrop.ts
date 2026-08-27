import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel";
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      traceExporter: new OTLPHttpProtoTraceExporter({
        url: "https://api.raindrop.ai/v1/traces",
        headers: {
          Authorization: `Bearer ${process.env.RAINDROP_WRITE_KEY}`,
        },
      }),
    }),
});
