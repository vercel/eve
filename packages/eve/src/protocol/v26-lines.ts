import { isStoredLine } from "./session-events/envelope.js";

export function isV26Line(record: unknown): boolean {
  return (
    typeof record === "object" &&
    record !== null &&
    !Array.isArray(record) &&
    typeof (record as { readonly type?: unknown }).type === "string" &&
    !isStoredLine(record)
  );
}
