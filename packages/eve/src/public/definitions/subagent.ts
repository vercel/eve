/**
 * Marker discriminator written into every {@link DisabledSubagentSentinel}.
 */
const DISABLED_SUBAGENT_SENTINEL_KIND = "eve:disabled-subagent";

/**
 * Marker value returned from {@link disableSubagent}. Export this as the
 * default export of a file in `agent/subagents/` to omit the subagent whose
 * name matches the file or directory slug.
 */
export interface DisabledSubagentSentinel {
  readonly kind: typeof DISABLED_SUBAGENT_SENTINEL_KIND;
}

/**
 * Returns a sentinel that disables the subagent whose name matches the
 * containing file or directory slug.
 */
export function disableSubagent(): DisabledSubagentSentinel {
  return {
    kind: DISABLED_SUBAGENT_SENTINEL_KIND,
  };
}

/**
 * Type guard: returns whether `value` is a {@link DisabledSubagentSentinel}
 * produced by {@link disableSubagent}.
 */
export function isDisabledSubagentSentinel(value: unknown): value is DisabledSubagentSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === DISABLED_SUBAGENT_SENTINEL_KIND
  );
}
