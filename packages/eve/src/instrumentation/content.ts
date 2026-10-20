import type { InstrumentationEvent } from "#instrumentation/lifecycle.js";
import { readGatewayRouting } from "#shared/gateway-routing.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";

/** Returns an immutable event projection with conversation content removed. */
export function withoutInstrumentationContent(event: InstrumentationEvent): InstrumentationEvent {
  return withInstrumentationDecision(event, {
    action: "record",
    recordInputs: false,
    recordOutputs: false,
  });
}

/** Inputs enter the agent; responses, requests for a person, metadata and errors leave it. */
export function withInstrumentationDecision(
  event: InstrumentationEvent,
  decision: Extract<InstrumentationDecision, { action: "record" }>,
): InstrumentationEvent {
  switch (event.type) {
    case "session.started":
      return decision.recordInputs ? event : Object.freeze({ ...event, title: undefined });
    case "call.requested":
      return decision.recordInputs
        ? event
        : Object.freeze({
            ...event,
            input: undefined,
            capability: Object.freeze({ ...event.capability, label: undefined }),
          });
    case "delivery.consumed":
    case "model.call.started":
      return decision.recordInputs ? event : Object.freeze({ ...event, input: undefined });
    case "interaction.opened":
      return decision.recordOutputs ? event : Object.freeze({ ...event, request: undefined });
    case "interaction.settled":
      return Object.freeze({
        ...event,
        error: decision.recordOutputs ? event.error : undefined,
        answer: decision.recordInputs ? event.answer : undefined,
      });
    case "call.settled":
      return decision.recordOutputs
        ? event
        : Object.freeze({ ...event, error: undefined, output: undefined });
    case "model.call.settled":
      if (event.outcome === "failed")
        return decision.recordOutputs ? event : Object.freeze({ ...event, error: undefined });
      return decision.recordOutputs
        ? event
        : Object.freeze({
            ...event,
            content: undefined,
            providerMetadata:
              event.providerMetadata === undefined
                ? undefined
                : structuralProviderMetadata(event.providerMetadata),
          });
    case "memory.operation.settled":
      if (event.outcome === "failed")
        return decision.recordOutputs ? event : Object.freeze({ ...event, error: undefined });
      return decision.recordInputs ? event : Object.freeze({ ...event, outputRecords: undefined });
    case "model.retried":
    case "model.settled":
    case "session.ended":
    case "turn.settled":
      return decision.recordOutputs ? event : Object.freeze({ ...event, error: undefined });
    default:
      return event;
  }
}

/** Provider metadata fields that describe cost, identity, or routing rather than content. */
export function structuralProviderMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const gateway = metadata["gateway"];
  if (typeof gateway !== "object" || gateway === null || Array.isArray(gateway))
    return Object.freeze({});
  const source = gateway as Readonly<Record<string, unknown>>;
  const structural: Record<string, unknown> = {};
  for (const key of ["cost", "generationId"] as const) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number") structural[key] = value;
  }
  const routing = readGatewayRouting(source["routing"]);
  if (routing !== undefined) structural["routing"] = routing;
  return Object.freeze(
    Object.keys(structural).length === 0 ? {} : { gateway: Object.freeze(structural) },
  );
}
