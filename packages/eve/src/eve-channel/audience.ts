import type { ChannelAudience } from "#shared/channel-audience.js";
import type { AudienceContext } from "#shared/conversation-context.js";

export function defaultEveAudience(
  input: Omit<AudienceContext<undefined>, "state">,
): ChannelAudience {
  if (input.caller.type === "anonymous") return "public";
  const principalType = input.caller.principal.kind;
  if (principalType === "user" || principalType === "service" || principalType === "runtime") {
    return "private";
  }
  return "unknown";
}
