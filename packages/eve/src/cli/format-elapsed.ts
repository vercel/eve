const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;

/** Formats elapsed milliseconds with the smallest useful unit breakdown. */
export function formatElapsed(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError("Elapsed time must be a finite, non-negative number.");
  }

  const roundedMilliseconds = Math.round(milliseconds);
  if (roundedMilliseconds < SECOND_MS) return `${roundedMilliseconds}ms`;
  if (roundedMilliseconds < MINUTE_MS) {
    return `${Math.round(roundedMilliseconds / 100) / 10}s`;
  }

  const totalSeconds = Math.floor(roundedMilliseconds / SECOND_MS);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);

  if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  if (totalHours > 0) return `${totalHours}h ${minutes}m ${seconds}s`;
  return `${totalMinutes}m ${seconds}s`;
}
