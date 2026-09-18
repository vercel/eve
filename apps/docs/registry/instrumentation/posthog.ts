import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PostHogTraceExporter } from "@posthog/ai/otel";
import { otelIntegration } from "eve/instrumentation/otel";

export default otelIntegration({
  exportPolicy: {
    span: () => ({ redact: true, inputs: true, outputs: true }),
  },
  spanProcessors: [
    new SimpleSpanProcessor(
      new PostHogTraceExporter({
        projectToken: process.env.POSTHOG_PROJECT_TOKEN!,
        host: process.env.POSTHOG_HOST,
      }),
    ),
  ],
  runtimeContext(input) {
    const distinctId =
      input.session.auth.initiator?.principalId ?? input.session.auth.current?.principalId;

    return distinctId ? { "posthog.distinct_id": distinctId } : undefined;
  },
});
