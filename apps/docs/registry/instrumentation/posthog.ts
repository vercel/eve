import { trace } from "@opentelemetry/api";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PostHogTraceExporter } from "@posthog/ai/otel";
import { registerOTel } from "@vercel/otel";
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      spanProcessors: [
        new SimpleSpanProcessor(
          new PostHogTraceExporter({
            projectToken: process.env.POSTHOG_PROJECT_TOKEN!,
            host: process.env.POSTHOG_HOST,
          }),
        ),
      ],
    }),
  events: {
    "step.started"(input) {
      const distinctId =
        input.session.auth.initiator?.principalId ?? input.session.auth.current?.principalId;

      if (!distinctId) return undefined;

      trace.getActiveSpan()?.setAttribute("posthog.distinct_id", distinctId);
      return { runtimeContext: { posthog_distinct_id: distinctId } };
    },
  },
});
