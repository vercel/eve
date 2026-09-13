import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";
import type { ConversationEnvironment } from "#shared/conversation-context.js";
import type { ChannelAudience } from "#shared/channel-audience.js";

export interface InstrumentationContentContext {
  readonly audience: ChannelAudience;
  readonly environment: ConversationEnvironment;
}

/** Content is public evidence, or local debugging evidence in development. */
export function shouldCaptureInstrumentationContent(
  context: InstrumentationContentContext,
): boolean {
  return context.audience === "public" || context.environment === "development";
}

/** Per-delivery audience is a hard ceiling over the session-level trace decision. */
export function applyAudienceCeiling(
  decision: InstrumentationDecision,
  context: InstrumentationContentContext,
): InstrumentationDecision {
  if (decision.action === "drop" || shouldCaptureInstrumentationContent(context)) {
    return decision;
  }
  return { action: "record", recordInputs: false, recordOutputs: false };
}
