import { type CompiledChannel, isCompiledChannel } from "#channel/compiled-channel.js";

/**
 * Normalizes one authored channel definition into the canonical internal
 * shape consumed by the compiler.
 *
 * Authored channels must go through {@link defineChannel} (or a wrapper
 * like `slackChannel` / `eveChannel`) and therefore must be
 * {@link CompiledChannel} values. The legacy plain-`{ fetch, receive? }`
 * Route shape is no longer supported — drop a clear error for it so
 * users on old patterns get a useful migration hint instead of a silent
 * runtime crash deeper in dispatch.
 *
 * Disable sentinels are handled by the compiler before this function is
 * called.
 */
export function normalizeChannelDefinition(value: unknown, message: string): CompiledChannel {
  if (!isCompiledChannel(value)) {
    throw new Error(
      `${message} Use \`defineChannel({ routes, ... })\` (or a wrapper like \`slackChannel\` / \`eveChannel\`) — bare \`{ fetch, receive? }\` channel objects are no longer supported.`,
    );
  }
  return value;
}
