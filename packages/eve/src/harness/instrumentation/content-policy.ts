import type { InstrumentationHooks } from "#instrumentation/lifecycle.js";
import { withoutInstrumentationContent } from "#instrumentation/content.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import type { ChannelAudience } from "#shared/channel-audience.js";

/** Hosted instrumentation records conversation content only for known-public channels. */
export function shouldCaptureInstrumentationContent(audience: ChannelAudience): boolean {
  if (audience === "public") return true;
  return audience === "unknown" && isEveDevEnvironment();
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
