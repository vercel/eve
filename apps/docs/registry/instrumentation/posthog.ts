import { PostHogTraceExporter } from "@posthog/ai/otel";
import { otelIntegration } from "eve/instrumentation/otel";

export default otelIntegration({
  traceExporter: new PostHogTraceExporter({
    projectToken: process.env.POSTHOG_PROJECT_TOKEN!,
    host: process.env.POSTHOG_HOST,
  }),
});
