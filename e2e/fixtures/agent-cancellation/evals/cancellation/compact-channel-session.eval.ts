import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

interface MessageResponse {
  readonly ok: boolean;
  readonly sessionId?: string;
}

interface CompactResponse {
  readonly sessionId?: string;
  readonly status?: "accepted" | "no_active_session";
}

async function postJson<T>(target: EveEvalTargetHandle, path: string, body: unknown): Promise<T> {
  const response = await target.fetch(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${path} failed (${response.status}): ${text}`);
  }
  return JSON.parse(text) as T;
}

/**
 * Compact a parked conversation through a custom channel route.
 *
 * The compact request uses only the channel-local continuation token. It
 * emits the compaction lifecycle without a synthetic model turn, preserves
 * the session owner, and allows the next ordinary message to resume normally.
 */
export default defineEval({
  description: "Compact a custom-channel session without creating a synthetic turn.",
  timeoutMs: 240_000,

  async test(t) {
    const unknownThread = await postJson<CompactResponse>(
      t.target,
      `/threads/${crypto.randomUUID()}/compact`,
      {},
    );
    await t.require(
      unknownThread,
      satisfies(
        (value: CompactResponse) => value.status === "no_active_session",
        "compacting an unknown thread reports no_active_session",
      ),
    );

    const threadId = crypto.randomUUID();
    const started = await postJson<MessageResponse>(t.target, `/threads/${threadId}/messages`, {
      message: "Reply with exactly COMPACT-INITIAL-OK.",
    });
    await t.require(
      started,
      satisfies(
        (value: MessageResponse) => value.ok === true && typeof value.sessionId === "string",
        "the initial message starts a session",
      ),
    );
    const sessionId = started.sessionId!;

    const initial = await t.target.watchTurn(sessionId).result();
    initial.notEvent("turn.failed");
    initial.notEvent("session.failed");

    const liveCompaction = t.target.watchTurn(sessionId, {
      startIndex: initial.events.length,
    });
    const compactedResponse = await postJson<CompactResponse>(
      t.target,
      `/threads/${threadId}/compact`,
      {},
    );
    await t.require(
      compactedResponse,
      satisfies(
        (value: CompactResponse) => value.status === "accepted" && value.sessionId === sessionId,
        "the channel accepts compaction for the active session",
      ),
    );

    const compacted = await liveCompaction.result();
    compacted.event("compaction.requested", { count: 1 });
    compacted.event("compaction.completed", { count: 1 });
    compacted.eventOrder([
      { type: "compaction.requested" },
      { type: "compaction.completed" },
      { type: "session.waiting" },
    ]);
    compacted.notEvent("turn.started");
    compacted.notEvent("turn.failed");
    compacted.notEvent("session.failed");

    const resumed = await postJson<MessageResponse>(t.target, `/threads/${threadId}/messages`, {
      message: "Reply with exactly COMPACT-FOLLOW-UP-OK.",
    });
    await t.require(
      resumed,
      satisfies(
        (value: MessageResponse) => value.sessionId === sessionId,
        "the thread resumes the same session after compaction",
      ),
    );

    const followUp = await t.target
      .watchTurn(sessionId, {
        startIndex: initial.events.length + compacted.events.length,
      })
      .result();
    followUp.notEvent("turn.failed");
    followUp.notEvent("session.failed");
    followUp.messageIncludes(/COMPACT-FOLLOW-UP-OK/i);

    t.succeeded();
  },
});
