import { OTLPHttpProtoTraceExporter } from "@vercel/otel";
import { otelIntegration } from "eve/instrumentation/otel";

export default otelIntegration({
  traceExporter: new OTLPHttpProtoTraceExporter({
    url: process.env.SENTRY_OTLP_TRACES_ENDPOINT!,
    headers: {
      "x-sentry-auth": `sentry sentry_key=${process.env.SENTRY_PUBLIC_KEY}`,
    },
  }),
});
