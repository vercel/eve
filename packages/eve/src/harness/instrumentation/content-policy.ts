import {
  withInstrumentationDecision,
  withoutInstrumentationContent,
} from "#harness/instrumentation/content.js";
import type { InstrumentationEvent } from "#harness/instrumentation/lifecycle.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import { applyAudienceCeiling } from "#shared/instrumentation-content.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";

/** Applies OpenTelemetry's trace content ceiling to one OTel provider event. */
export function instrumentationEventForTraceDecision(
  event: InstrumentationEvent,
  decision: InstrumentationDecision,
  audience: ChannelAudience,
): InstrumentationEvent {
  const effective = applyAudienceCeiling(decision, audience);
  return effective.action === "drop"
    ? withoutInstrumentationContent(event)
    : withInstrumentationDecision(event, effective);
}
