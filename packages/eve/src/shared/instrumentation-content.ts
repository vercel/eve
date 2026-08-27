import type { ChannelAudience } from "#shared/channel-audience.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";

/** Hosted instrumentation records conversation content only for known-public channels. */
export function shouldCaptureInstrumentationContent(audience: ChannelAudience): boolean {
  if (audience === "public") return true;
  return audience === "unknown" && process.env.EVE_DEV === "1";
}

/** Per-delivery audience is a hard ceiling over the session-level trace decision. */
export function applyAudienceCeiling(
  decision: InstrumentationDecision,
  audience: ChannelAudience,
): InstrumentationDecision {
  if (decision.action === "drop" || shouldCaptureInstrumentationContent(audience)) {
    return decision;
  }
  return { action: "record", recordInputs: false, recordOutputs: false };
}
