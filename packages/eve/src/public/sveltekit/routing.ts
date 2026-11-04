/**
 * Reduce an origin string to its canonical `protocol://host[:port]` form.
 */
export function normalizeOrigin(origin: string): string {
  return new URL(origin.trim()).origin;
}
