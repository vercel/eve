import type { InstrumentationHooks } from "#harness/instrumentation/lifecycle.js";
import {
  withInstrumentationDecision,
  withoutInstrumentationContent,
} from "#harness/instrumentation/content.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import {
  applyAudienceCeiling,
  shouldCaptureInstrumentationContent,
} from "#shared/instrumentation-content.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";
export { shouldCaptureInstrumentationContent } from "#shared/instrumentation-content.js";

export function instrumentationHooksForDecision(
  hooks: InstrumentationHooks | undefined,
  decision: InstrumentationDecision,
  audience: ChannelAudience,
): InstrumentationHooks | undefined {
  if (decision.action === "drop") return instrumentationHooksForAudience(hooks, audience);
  const effective = applyAudienceCeiling(decision, audience);
  if (
    effective.action === "drop" ||
    hooks === undefined ||
    !hooks.capturesContent ||
    (effective.recordInputs && effective.recordOutputs)
  ) {
    return hooks;
  }
  return {
    capturesContent: effective.recordInputs || effective.recordOutputs,
    publish: (event) => hooks.publish(withInstrumentationDecision(event, effective)),
  };
}

/** Applies the audience ceiling before any content-capable provider sees an event. */
export function instrumentationHooksForAudience(
  hooks: InstrumentationHooks | undefined,
  audience: ChannelAudience,
): InstrumentationHooks | undefined {
  if (
    hooks === undefined ||
    !hooks.capturesContent ||
    shouldCaptureInstrumentationContent(audience)
  ) {
    return hooks;
  }

  return {
    capturesContent: false,
    publish: (event) => hooks.publish(withoutInstrumentationContent(event)),
  };
}
