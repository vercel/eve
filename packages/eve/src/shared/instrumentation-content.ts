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

/** An explicit policy overrides defaults only for the audience it evaluated. */
export function applyAudienceCeiling(
  decision: InstrumentationDecision,
  context: InstrumentationContentContext,
): InstrumentationDecision {
  if (
    decision.action === "drop" ||
    decision.explicitContentAudience === context.audience ||
    shouldCaptureInstrumentationContent(context)
  ) {
    return decision;
  }
  return { action: "record", recordInputs: false, recordOutputs: false };
}
