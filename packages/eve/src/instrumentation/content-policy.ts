import {
  withInstrumentationDecision,
  withoutInstrumentationContent,
} from "#instrumentation/content.js";
import type { InstrumentationEvent } from "#instrumentation/lifecycle.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import { applyAudienceCeiling } from "#shared/instrumentation-content.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";

/** Applies OpenTelemetry's trace content ceiling to one OTel provider event. */
export function instrumentationEventForTraceDecision(
  event: InstrumentationEvent,
  decision: InstrumentationDecision,
  audience: ChannelAudience,
  options: { readonly applyAudienceCeiling?: boolean } = {},
): InstrumentationEvent {
  const effective =
    options.applyAudienceCeiling === false ? decision : applyAudienceCeiling(decision, audience);
  return effective.action === "drop"
    ? withoutInstrumentationContent(event)
    : withInstrumentationDecision(event, effective);
}
