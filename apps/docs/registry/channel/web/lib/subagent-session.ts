import { readMessageStream } from "eve/client";
import type { SubagentCalledStreamEvent } from "eve/client";

export type SubagentSession = SubagentCalledStreamEvent["data"];
export function subagentKey(session: SubagentSession) {
  return JSON.stringify([session.sessionId, session.remote?.url ?? null, session.childSessionId]);
}
export function subagentStreamPath(session: SubagentSession, startIndex = 0) {
  const parent = encodeURIComponent(session.sessionId);
  const child = encodeURIComponent(session.childSessionId);
  const call = encodeURIComponent(session.callId);
  // Derive same-origin framework routes; never fetch an event's remote URL in the browser.
  const path = session.remote
    ? `/eve/v1/session/${parent}/subagents/${call}/${child}/stream`
    : `/eve/v1/session/${child}/stream`;
  const query = new URLSearchParams({
    startIndex: String(startIndex),
    includeTailIndex: "1",
    streamControlVersion: "1",
  });
  if (!session.remote) {
    query.set("parentSessionId", session.sessionId);
    query.set("callId", session.callId);
  }
  return `${path}?${query}`;
}

export function readSubagentEvents(response: Response, signal: AbortSignal) {
  return readMessageStream(response, { signal });
}
