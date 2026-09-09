import type { SessionStateMap } from "#harness/types.js";

/**
 * Session-state slot holding approval keys the person granted for `once()`
 * style policies. Kept dependency-free so the code_mode workflow body can
 * carry the slot between nested calls and back to the parent session.
 */
export const APPROVED_TOOLS_KEY = "eve.runtime.hitl.approvedTools";

export function readApprovedToolKeys(state: SessionStateMap | undefined): readonly string[] {
  const value = state?.[APPROVED_TOOLS_KEY];
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
}

/** Returns `state` with exactly `keys` recorded; the same object when nothing changes. */
export function writeApprovedToolKeys(
  state: SessionStateMap | undefined,
  keys: readonly string[],
): SessionStateMap | undefined {
  const current = readApprovedToolKeys(state);
  if (current.length === keys.length && current.every((key, index) => key === keys[index])) {
    return state;
  }
  const next = { ...state };
  if (keys.length === 0) delete next[APPROVED_TOOLS_KEY];
  else next[APPROVED_TOOLS_KEY] = [...keys];
  return next;
}
