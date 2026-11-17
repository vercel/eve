export const PROGRESS_PULSE_GLYPH = "▪";

export const PROGRESS_PULSE_ASCII_GLYPH = "*";

export const PROGRESS_PULSE_SEQUENCE = "1111110000111111";

export const PROGRESS_PULSE_DURATION_MS = 1000;

export function isProgressPulseVisible(elapsedMs: number): boolean {
  const loopTime = elapsedMs % PROGRESS_PULSE_DURATION_MS;
  const step = Math.floor((loopTime * PROGRESS_PULSE_SEQUENCE.length) / PROGRESS_PULSE_DURATION_MS);
  return PROGRESS_PULSE_SEQUENCE[step] === "1";
}
