import { SessionDynamicModelReferenceKey } from "#context/keys.js";

/** Keeps a completed session-scoped model selection when its turn is cancelled. */
export function preserveSerializedSessionDynamicModelSelection(
  original: Record<string, unknown>,
  interrupted: Record<string, unknown>,
): Record<string, unknown> {
  const selection = interrupted[SessionDynamicModelReferenceKey.name];
  return selection === undefined
    ? original
    : { ...original, [SessionDynamicModelReferenceKey.name]: selection };
}
