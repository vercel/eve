import { SessionDynamicInstructionsKey } from "#context/keys.js";

/**
 * Keeps the session-scoped instructions a cancelled turn already resolved.
 * The cancelled turn still marks the session started, so no later turn
 * resolves them again.
 */
export function preserveSerializedSessionDynamicInstructions(
  original: Record<string, unknown>,
  interrupted: Record<string, unknown>,
): Record<string, unknown> {
  const instructions = interrupted[SessionDynamicInstructionsKey.name];
  return instructions === undefined
    ? original
    : { ...original, [SessionDynamicInstructionsKey.name]: instructions };
}
