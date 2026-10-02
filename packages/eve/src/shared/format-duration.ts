/** `450ms`, `14s`, `2m 14s`, `1h 3m`: whole units, leaving out the zero ones. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${String(Math.max(0, Math.round(ms)))}ms`;
  const totalSeconds = Math.round(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${String(hours)}h`);
  if (minutes > 0) parts.push(`${String(minutes)}m`);
  if (seconds > 0) parts.push(`${String(seconds)}s`);
  return parts.join(" ");
}
