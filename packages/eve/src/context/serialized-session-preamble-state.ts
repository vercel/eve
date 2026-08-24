import {
  DynamicSkillManifestKey,
  SessionDynamicInstructionsKey,
  SessionDynamicModelReferenceKey,
  SessionDynamicSubagentRuntimeRevisionKey,
  SessionDynamicSubagentSelectionsKey,
  SessionDynamicToolMetadataKey,
  SessionDynamicToolRuntimeRevisionKey,
} from "#context/keys.js";

const SESSION_PREAMBLE_KEYS = [
  SessionDynamicModelReferenceKey,
  SessionDynamicToolMetadataKey,
  SessionDynamicToolRuntimeRevisionKey,
  SessionDynamicSubagentSelectionsKey,
  SessionDynamicSubagentRuntimeRevisionKey,
  DynamicSkillManifestKey,
  SessionDynamicInstructionsKey,
] as const;

/** Keeps durable session.started resolver output when its turn is cancelled. */
export function preserveSerializedSessionPreambleState(
  original: Record<string, unknown>,
  interrupted: Record<string, unknown>,
): Record<string, unknown> {
  let preserved = original;
  for (const key of SESSION_PREAMBLE_KEYS) {
    const value = interrupted[key.name];
    if (value !== undefined) preserved = { ...preserved, [key.name]: value };
  }
  return preserved;
}
