import { OTLPHttpProtoTraceExporter } from "@vercel/otel";
import { otelIntegration } from "eve/instrumentation/otel";

export default otelIntegration({
  traceExporter: new OTLPHttpProtoTraceExporter({
    url: "https://otlp.arize.com/v1/traces",
    headers: {
      space_id: process.env.ARIZE_SPACE_ID!,
      api_key: process.env.ARIZE_API_KEY!,
    },
  }),
});
