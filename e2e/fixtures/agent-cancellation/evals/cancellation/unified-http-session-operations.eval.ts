import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const TOOL_NAME = "wait-for-cancellation";

interface AcceptedResponse {
  readonly ok?: boolean;
  readonly sessionId?: string;
  readonly status?: string;
}

interface ResetResponse {
  readonly ok?: boolean;
  readonly previousSessionId?: string;
  readonly status?: string;
}

async function postJson<T>(
  target: EveEvalTargetHandle,
  path: string,
  body: unknown,
  expectedStatus: number,
): Promise<T> {
  const response = await target.fetch(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(
      `POST ${path} returned ${response.status}, expected ${expectedStatus}: ${text}`,
    );
  }
  return JSON.parse(text) as T;
}

/** Exercises every ID-only eve HTTP session operation as one lifecycle. */
export default defineEval({
  tags: ["real-model"],
  description: "Keep HTTP session operations pinned to one immutable session ID.",
  timeoutMs: 240_000,

  async test(t) {
    const created = await postJson<AcceptedResponse>(
      t.target,
      "/eve/v1/session",
      { message: "Reply with exactly HTTP-SESSION-INITIAL-OK." },
      202,
    );
    await t.require(
      created,
      satisfies(
        (value: AcceptedResponse) =>
          value.ok === true && value.status === "accepted" && typeof value.sessionId === "string",
        "the HTTP session route creates a session without a continuation token",
      ),
    );
    const sessionId = created.sessionId!;

    const initial = await t.target.watchTurn(sessionId).result();
    initial.notEvent("turn.failed");
    initial.notEvent("session.failed");
    initial.messageIncludes(/HTTP-SESSION-INITIAL-OK/i);

    const liveCancellation = t.target.watchTurn(sessionId, {
      startIndex: initial.events.length,
    });
    const sent = await postJson<AcceptedResponse>(
      t.target,
      `/eve/v1/session/${sessionId}`,
      { message: "Please wait for cancellation." },
      202,
    );
    await t.require(
      sent,
      satisfies(
        (value: AcceptedResponse) => value.status === "accepted" && value.sessionId === sessionId,
        "the message route sends to the exact session ID",
      ),
    );

    await liveCancellation.waitForEvent("actions.requested", {
      data: {
        actions: (actions) =>
          actions.some((action) => action.kind === "tool-call" && action.toolName === TOOL_NAME),
      },
    });
    const cancelled = await postJson<AcceptedResponse>(
      t.target,
      `/eve/v1/session/${sessionId}/cancel`,
      {},
      200,
    );
    await t.require(
      cancelled,
      satisfies(
        (value: AcceptedResponse) => value.status === "accepted" && value.sessionId === sessionId,
        "cancel targets the exact session ID",
      ),
    );

    const cancelledTurn = await liveCancellation.result();
    cancelledTurn.event("turn.cancelled", { count: 1 });
    cancelledTurn.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
    cancelledTurn.notEvent("turn.failed");
    cancelledTurn.notEvent("session.failed");

    let eventIndex = initial.events.length + cancelledTurn.events.length;
    const liveCompaction = t.target.watchTurn(sessionId, { startIndex: eventIndex });
    const compacted = await postJson<AcceptedResponse>(
      t.target,
      `/eve/v1/session/${sessionId}/compact`,
      {},
      202,
    );
    await t.require(
      compacted,
      satisfies(
        (value: AcceptedResponse) => value.status === "accepted" && value.sessionId === sessionId,
        "compact targets the exact session ID",
      ),
    );
    const compactedEvents = await liveCompaction.result();
    compactedEvents.eventOrder([
      { type: "compaction.requested" },
      { type: "compaction.completed" },
      { type: "session.waiting" },
    ]);
    compactedEvents.notEvent("turn.started");
    eventIndex += compactedEvents.events.length;

    const liveClear = t.target.watchTurn(sessionId, { startIndex: eventIndex });
    const cleared = await postJson<AcceptedResponse>(
      t.target,
      `/eve/v1/session/${sessionId}/clear`,
      {},
      202,
    );
    await t.require(
      cleared,
      satisfies(
        (value: AcceptedResponse) => value.status === "accepted" && value.sessionId === sessionId,
        "clear targets the exact session ID",
      ),
    );
    const clearedEvents = await liveClear.result();
    clearedEvents.event("context.cleared", { count: 1 });
    clearedEvents.eventOrder([{ type: "context.cleared" }, { type: "session.waiting" }]);
    clearedEvents.notEvent("turn.started");
    eventIndex += clearedEvents.events.length;

    const liveFollowUp = t.target.watchTurn(sessionId, { startIndex: eventIndex });
    const followUpResponse = await postJson<AcceptedResponse>(
      t.target,
      `/eve/v1/session/${sessionId}`,
      { message: "Reply with exactly HTTP-SESSION-FOLLOW-UP-OK." },
      202,
    );
    await t.require(
      followUpResponse,
      satisfies(
        (value: AcceptedResponse) => value.status === "accepted" && value.sessionId === sessionId,
        "the same session accepts a message after compact and clear",
      ),
    );
    const followUp = await liveFollowUp.result();
    followUp.notEvent("turn.failed");
    followUp.notEvent("session.failed");
    followUp.messageIncludes(/HTTP-SESSION-FOLLOW-UP-OK/i);

    const reset = await postJson<ResetResponse>(
      t.target,
      `/eve/v1/session/${sessionId}/reset`,
      { reason: "Verify immutable HTTP session identity" },
      200,
    );
    await t.require(
      reset,
      satisfies(
        (value: ResetResponse) => value.status === "reset" && value.previousSessionId === sessionId,
        "reset terminally retires the exact session ID",
      ),
    );

    const rejected = await postJson<{ readonly code?: string; readonly ok?: boolean }>(
      t.target,
      `/eve/v1/session/${sessionId}`,
      { message: "This must not create or follow a replacement." },
      409,
    );
    await t.require(
      rejected,
      satisfies(
        (value: { readonly code?: string; readonly ok?: boolean }) =>
          value.ok === false && value.code === "session_not_active",
        "a reset session ID cannot send or create a replacement",
      ),
    );

    const replacement = await postJson<AcceptedResponse>(
      t.target,
      "/eve/v1/session",
      { message: "Reply with exactly HTTP-SESSION-REPLACEMENT-OK." },
      202,
    );
    await t.require(
      replacement,
      satisfies(
        (value: AcceptedResponse) =>
          value.status === "accepted" &&
          typeof value.sessionId === "string" &&
          value.sessionId !== sessionId,
        "a replacement session requires explicit creation",
      ),
    );

    const replacementTurn = await t.target.watchTurn(replacement.sessionId!).result();
    replacementTurn.notEvent("turn.failed");
    replacementTurn.notEvent("session.failed");
    replacementTurn.messageIncludes(/HTTP-SESSION-REPLACEMENT-OK/i);

    t.succeeded();
  },
});
