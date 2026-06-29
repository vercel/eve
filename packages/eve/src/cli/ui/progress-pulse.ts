/** The one-cell pulse used while `eve dev` builds an agent. */
export const PROGRESS_PULSE_GLYPH = "▪";

/** Single-cell fallback for terminals without Unicode glyph support. */
export const PROGRESS_PULSE_ASCII_GLYPH = "*";

/** Lit and unlit steps in the build indicator's one-second loop. */
export const PROGRESS_PULSE_SEQUENCE = "1111110000111111";

/** Duration of one complete build-indicator pulse. */
export const PROGRESS_PULSE_DURATION_MS = 1000;

/** Whether the shared build pulse is lit at an elapsed time. */
export function isProgressPulseVisible(elapsedMs: number): boolean {
  const loopTime = elapsedMs % PROGRESS_PULSE_DURATION_MS;
  const step = Math.floor((loopTime * PROGRESS_PULSE_SEQUENCE.length) / PROGRESS_PULSE_DURATION_MS);
  return PROGRESS_PULSE_SEQUENCE[step] === "1";
}
