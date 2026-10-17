/** Incremental UTF-8 collector with the same 16 KiB / 256-entry cap as QuickJS. */
export function collectPythonLogs(logs: string[], text: string): void {
  if (logs.length >= 256) return;
  const remaining = 16 * 1024 - logs.reduce((size, line) => size + Buffer.byteLength(line), 0);
  if (remaining <= 0) return;
  // Slice before encoding so a large guest print cannot allocate an equally large host Buffer.
  const bytes = Buffer.from(text.slice(0, remaining));
  const line = bytes.subarray(0, remaining).toString("utf8");
  const safe = Buffer.byteLength(line) <= remaining ? line : line.slice(0, -1);
  logs.push(safe);
}
