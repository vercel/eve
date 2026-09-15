import type { ChannelAudience } from "#shared/channel-audience.js";
import type { AudienceContext } from "#shared/conversation-context.js";

export function defaultEveAudience(
  input: Omit<AudienceContext<undefined>, "state">,
): ChannelAudience {
  if (
    input.caller.type === "principal" &&
    (input.caller.principal.kind === "user" ||
      input.caller.principal.kind === "service" ||
      input.caller.principal.kind === "runtime")
  ) {
    return "private";
  }
  return "unknown";
}
