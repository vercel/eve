import type { inspectForLog as NodeTwin } from "./inspect.js";

// A value rendered for a log line in a browser, which has no `util.inspect`: an error with its
// stack and cause chain, anything else as JSON. `inspect.ts` is the Node twin.

export const inspectForLog: typeof NodeTwin = (value, depth, maxStringLength) => {
  const lines: string[] = [];
  let current: unknown = value;
  for (let level = 0; current !== undefined && level <= depth; level++) {
    if (current instanceof Error) {
      lines.push(
        (current.stack ?? `${current.name}: ${current.message}`).slice(0, maxStringLength),
      );
      current = current.cause;
      if (current !== undefined) lines.push("[cause]:");
    } else {
      lines.push(stringify(current).slice(0, maxStringLength));
      current = undefined;
    }
  }
  return lines.join("\n");
};

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
