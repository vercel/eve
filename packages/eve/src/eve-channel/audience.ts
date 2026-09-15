import type { ChannelAudience } from "#shared/channel-audience.js";
import type { AudienceInput } from "#shared/conversation-context.js";

export function defaultEveAudience(
  input: Omit<AudienceInput<undefined>, "state">,
): ChannelAudience {
  const principalType = input.auth?.principalType ?? "anonymous";
  if (principalType === "anonymous") return "public";
  if (principalType === "user" || principalType === "service" || principalType === "runtime") {
    return "private";
  }
  return "unknown";
}
