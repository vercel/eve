import { inspect } from "node:util";

export function inspectForLog(value: unknown, depth: number, maxStringLength: number): string {
  return inspect(value, {
    breakLength: Number.POSITIVE_INFINITY,
    compact: false,
    depth,
    maxStringLength,
  });
}
