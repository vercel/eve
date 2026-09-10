import { defineInstrumentation, type ProviderDefinition } from "eve/instrumentation";

function code(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)
    ? value
    : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export default defineInstrumentation({
  // This fixture receives metadata in memory but persists only the bounded codes below.
  tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: true }),
  events: {
    "model.call.completed"(event) {
      if (event.finishReason !== "content-filter") return;
      console.error(
        "EVE_E2E_REFUSAL",
        JSON.stringify({
          event: event.type,
          finishReason: event.finishReason,
          sessionId: code(event.scope.sessionId),
          turnId: code(event.scope.turnId),
          stepIndex: event.scope.stepIndex,
          attemptIndex: event.scope.attemptIndex,
        }),
      );
    },
    "step.attempt.metadata"(event) {
      const stop = record(record(event.providerMetadata.anthropic).stopDetails);
      if (stop.type !== "refusal") return;
      console.error(
        "EVE_E2E_REFUSAL",
        JSON.stringify({
          event: event.type,
          providerStopType: code(stop.type),
          providerStopCategory: code(stop.category),
          generationId: code(record(event.providerMetadata.gateway).generationId),
          sessionId: code(event.scope.sessionId),
          turnId: code(event.scope.turnId),
          stepIndex: event.scope.stepIndex,
          attemptIndex: event.scope.attemptIndex,
        }),
      );
    },
  },
} satisfies ProviderDefinition);
