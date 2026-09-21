import { OTLPHttpProtoTraceExporter } from "@vercel/otel";
import { otelIntegration } from "eve/instrumentation/otel";

export default otelIntegration({
  exportPolicy: {
    span: () => ({ redact: true, inputs: true, outputs: true }),
  },
  traceExporter: new OTLPHttpProtoTraceExporter({
    url: "https://api.raindrop.ai/v1/traces",
    headers: {
      Authorization: `Bearer ${process.env.RAINDROP_WRITE_KEY}`,
    },
  }),
});
