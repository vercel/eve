/** Applies one stream delta, replacing accumulated text at a block boundary. */
export function applyStreamTextDelta(
  text: string | undefined,
  startsBlock: boolean,
  delta: string,
): string | undefined {
  if (startsBlock) return delta;
  if (text === undefined) return undefined;
  return text + delta;
}
