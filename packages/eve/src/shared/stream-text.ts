/**
 * Applies one offset-addressed stream delta to accumulated text.
 *
 * An offset of `0` starts or restarts a block. Later deltas must begin exactly
 * where the accumulated text ends; a gap or overlap returns `undefined` so the
 * consumer does not project corrupt text.
 */
export function appendStreamTextDelta(
  text: string | undefined,
  offset: number,
  delta: string,
): string | undefined {
  if (offset === 0) return delta;
  if (text?.length !== offset) return undefined;
  return text + delta;
}
