import type { InstrumentationEvent } from "#instrumentation/lifecycle.js";

/** Returns an immutable event projection with conversation content removed. */
export function withoutInstrumentationContent(event: InstrumentationEvent): InstrumentationEvent {
  switch (event.type) {
    case "channel.delivery.started":
      return Object.freeze({ ...event, input: undefined });
    case "action.started":
      return Object.freeze({ ...event, input: undefined });
    case "action.completed":
      return Object.freeze({ ...event, output: Object.freeze({ type: event.output.type }) });
    case "input.requested":
      return Object.freeze({ ...event, request: undefined });
    case "input.resolved":
      return Object.freeze({ ...event, error: undefined, response: undefined });
    case "tool.call.started":
      return Object.freeze({ ...event, input: undefined });
    case "tool.call.completed":
      return Object.freeze({ ...event, output: Object.freeze({ type: event.output.type }) });
    case "model.call.started":
      return Object.freeze({ ...event, input: undefined });
    case "model.call.completed":
      return Object.freeze({ ...event, content: undefined });
    case "step.attempt.metadata":
      return Object.freeze({
        ...event,
        providerMetadata: structuralProviderMetadata(event.providerMetadata),
      });
    case "action.failed":
    case "model.call.failed":
    case "session.failed":
    case "step.attempt.failed":
    case "tool.call.failed":
    case "turn.failed":
    case "channel.delivery.failed":
      return Object.freeze({ ...event, error: undefined });
    default:
      return event;
  }
}

/** Provider metadata fields that describe cost/identity rather than content. */
export function structuralProviderMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const gateway = metadata["gateway"];
  if (typeof gateway !== "object" || gateway === null || Array.isArray(gateway)) {
    return Object.freeze({});
  }
  const source = gateway as Readonly<Record<string, unknown>>;
  const structural: Record<string, string | number> = {};
  for (const key of ["cost", "generationId"] as const) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number") structural[key] = value;
  }
  return Object.freeze(
    Object.keys(structural).length === 0 ? {} : { gateway: Object.freeze(structural) },
  );
}
