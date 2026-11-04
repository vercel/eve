import { inspect } from "node:util";

// A value rendered for a log line, as Node renders it (`util.inspect`), causes included.
// `inspect.web.ts` is the browser's twin; the package's `#platform/*` imports pick one by the
// `node` condition.

export function inspectForLog(value: unknown, depth: number, maxStringLength: number): string {
  return inspect(value, {
    breakLength: Number.POSITIVE_INFINITY,
    compact: false,
    depth,
    maxStringLength,
  });
}
