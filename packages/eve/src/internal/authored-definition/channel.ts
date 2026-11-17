import { type CompiledChannel, isCompiledChannel } from "#channel/compiled-channel.js";

export function normalizeChannelDefinition(value: unknown, message: string): CompiledChannel {
  if (!isCompiledChannel(value)) {
    throw new Error(
      `${message} Use \`defineChannel({ routes, ... })\` (or a wrapper like \`slackChannel\` / \`eveChannel\`) — bare \`{ fetch, receive? }\` channel objects are no longer supported.`,
    );
  }
  return value;
}
