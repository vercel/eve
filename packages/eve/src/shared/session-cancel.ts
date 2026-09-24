// The one validation for `Session.cancel` options, shared by the eve channel
// route, channel sessions, and the session inbox. It stays free of imports so
// the session workflow body can read it.

/** Why the options of one cancel request are invalid, or `undefined` when they are valid. */
export function describeInvalidCancelOptions(options: {
  readonly turnId?: unknown;
}): string | undefined {
  const { turnId } = options;
  if (turnId !== undefined && (typeof turnId !== "string" || turnId.length === 0)) {
    return "Expected 'turnId' to be a non-empty string.";
  }
  return undefined;
}
