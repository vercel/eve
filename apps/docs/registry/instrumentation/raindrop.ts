import { OTLPHttpProtoTraceExporter } from "@vercel/otel";
import { otelIntegration } from "eve/instrumentation/otel";

export default otelIntegration({
  traceExporter: new OTLPHttpProtoTraceExporter({
    url: "https://api.raindrop.ai/v1/traces",
    headers: {
      Authorization: `Bearer ${process.env.RAINDROP_WRITE_KEY}`,
    },
  }),
});
