import {
  withInstrumentationDecision,
  withoutInstrumentationContent,
} from "#instrumentation/content.js";
import type { InstrumentationEvent } from "#instrumentation/lifecycle.js";
import {
  applyAudienceCeiling,
  type InstrumentationContentContext,
} from "#shared/instrumentation-content.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";

export function instrumentationEventForTraceDecision(
  event: InstrumentationEvent,
  decision: InstrumentationDecision,
  content: InstrumentationContentContext,
  options: { readonly applyAudienceCeiling?: boolean } = {},
): InstrumentationEvent {
  const effective =
    options.applyAudienceCeiling === false ? decision : applyAudienceCeiling(decision, content);
  return effective.action === "drop"
    ? withoutInstrumentationContent(event)
    : withInstrumentationDecision(event, effective);
}
