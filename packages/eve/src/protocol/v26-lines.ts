// eve before v27 stored one v26 event per line. A v27 deployment shares the World those
// sessions were recorded in; `#execution/v26-history.js` reads their lines as v27 commits.

import { isStoredLine } from "./session-events/envelope.js";

/**
 * True for a record an eve before v27 stored: a v26 `{type, data, meta}` event. No v27 line has a
 * top-level `type`, so a stream whose first line is one was started by an earlier eve.
 */
export function isV26Line(record: unknown): boolean {
  return (
    typeof record === "object" &&
    record !== null &&
    !Array.isArray(record) &&
    typeof (record as { readonly type?: unknown }).type === "string" &&
    !isStoredLine(record)
  );
}
