import { OTLPHttpProtoTraceExporter } from "@vercel/otel";
import { otelIntegration } from "eve/instrumentation/otel";

export default otelIntegration({
  traceExporter: new OTLPHttpProtoTraceExporter({
    url: process.env.DATADOG_OTLP_TRACES_ENDPOINT!,
    headers: { "dd-api-key": process.env.DD_API_KEY! },
  }),
});
