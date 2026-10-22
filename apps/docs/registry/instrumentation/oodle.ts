import { OTLPHttpProtoTraceExporter } from "@vercel/otel";
import { otelIntegration } from "eve/instrumentation/otel";

export default otelIntegration({
  exportPolicy: {
    span: () => ({ redact: true, inputs: true, outputs: true }),
  },
  traceExporter: new OTLPHttpProtoTraceExporter({
    url: `https://${process.env.OODLE_OTLP_ENDPOINT}/v1/traces`,
    headers: {
      "X-API-KEY": process.env.OODLE_API_KEY!,
      "X-OODLE-INSTANCE": process.env.OODLE_INSTANCE!,
    },
  }),
});
