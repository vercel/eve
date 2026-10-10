// eve before v27 stored one v26 event per line. A session a v27 deployment replaced may have
// been recorded that way, and the replacement reads its conversation with `transcriptReducer`.
// This reads just enough of a v26 line for that: what the person sent, the assistant's text, a
// clear, and the session's end, each as the v27 fact a transcript reads. Every other v26 event
// stays unreadable, as before.

import type { SessionEvent } from "./session-event.js";
import type { CommitLine } from "./session-events/envelope.js";

/**
 * The v27 commit a stored v26 event reads as, or `undefined` for a record that isn't one of the
 * v26 events a transcript reads. `position` names the facts the event had no id for.
 */
export function readV26TranscriptLine(
  record: unknown,
  position: number,
): CommitLine<SessionEvent> | undefined {
  if (!isRecord(record) || typeof record.type !== "string") return undefined;
  const data = isRecord(record.data) ? record.data : {};
  const fact = factOf(record.type, data, position);
  if (fact === undefined) return undefined;
  const meta = isRecord(record.meta) ? record.meta : {};
  const at = typeof meta.at === "string" ? meta.at : new Date(0).toISOString();
  return { at, facts: [fact] };
}

function factOf(
  type: string,
  data: Readonly<Record<string, unknown>>,
  position: number,
): SessionEvent | undefined {
  const id = `v26_${String(position)}`;
  const turnId = typeof data.turnId === "string" ? data.turnId : undefined;
  switch (type) {
    case "message.received": {
      if (turnId === undefined) return undefined;
      return {
        data: { deliveryId: id, parts: [{ kind: "text", text: receivedText(data) }], turnId },
        scope: { turnId },
        type: "delivery.consumed",
      };
    }
    case "message.completed": {
      if (turnId === undefined || typeof data.message !== "string") return undefined;
      return {
        data: {
          kind: "text",
          partId: id,
          // Text written before the step's tool calls narrated them.
          phase: data.finishReason === "tool-calls" ? "narration" : "reply",
          runId: id,
          value: data.message,
        },
        scope: { turnId },
        type: "content.completed",
      };
    }
    case "context.cleared":
      return {
        data: { changeId: id, kind: "clear", outcome: "completed", selects: null },
        type: "context.settled",
      };
    case "session.completed":
      return { data: { outcome: "completed" }, type: "session.ended" };
    case "session.failed": {
      const code = typeof data.code === "string" ? data.code : "session_failed";
      const message = typeof data.message === "string" ? data.message : "The session failed.";
      const details = isRecord(data.details) ? data.details : {};
      const ended: {
        outcome: "failed";
        error: { code: string; message: string };
        cause?: { policy: string };
      } = { error: { code, message }, outcome: "failed" };
      // A v26 deployment ending a stranded session recorded what ended it.
      if (code === "session_stranded" && typeof details.trigger === "string") {
        ended.cause = { policy: `stranded-${details.trigger}` };
      }
      return { data: ended, type: "session.ended" };
    }
    default:
      return undefined;
  }
}

/** A received message's text: its text parts, or its flattened text without them. */
function receivedText(data: Readonly<Record<string, unknown>>): string {
  if (!Array.isArray(data.parts)) return typeof data.message === "string" ? data.message : "";
  return data.parts
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
