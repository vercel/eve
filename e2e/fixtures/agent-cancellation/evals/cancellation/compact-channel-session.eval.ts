import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

interface Delivery {
  readonly ok: boolean;
  readonly sessionId?: string;
}

interface CompactResponse {
  readonly sessionId?: string;
  readonly deliveryId?: string;
  readonly code?: string;
}

/** The line after the last event read: where the next read starts. */
function nextLine(
  events: readonly { readonly meta: { readonly position: { readonly line: number } } }[],
) {
  return (events.at(-1)?.meta.position.line ?? -1) + 1;
}

async function postJson<T>(
  target: EveEvalTargetHandle,
  path: string,
  body: unknown,
  expectedStatus = 200,
): Promise<T> {
  const response = await target.fetch(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
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
      409,
    );
    await t.require(
      unknownThread,
      satisfies(
        (value: CompactResponse) => value.code === "session_not_active",
        "compacting an unknown thread reports session_not_active",
      ),
    );

    const threadId = crypto.randomUUID();
    const started = await postJson<Delivery>(t.target, `/threads/${threadId}/messages`, {
      message: "Reply with exactly COMPACT-INITIAL-OK.",
    });
    await t.require(
      started,
      satisfies(
        (value: Delivery) => value.ok === true && typeof value.sessionId === "string",
        "the initial message starts a session",
      ),
    );
    const sessionId = started.sessionId!;

    const initial = await t.target.attach(sessionId).watch().result();
    initial.notEvent("turn.settled", { data: { outcome: "failed" } });
    initial.notEvent("session.ended", { data: { outcome: "failed" } });

    // A context change between turns ends no turn: the read ends with its settlement.
    const liveCompaction = t.target
      .attach(sessionId, { startIndex: nextLine(initial.events) })
      .watch({ until: (event) => event.type === "context.settled" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const compactedResponse = await postJson<CompactResponse>(
      t.target,
      `/threads/${threadId}/compact`,
      {},
    );
    await t.require(
      compactedResponse,
      satisfies(
        (value: CompactResponse) =>
          typeof value.deliveryId === "string" && value.sessionId === sessionId,
        "the channel accepts compaction for the active session",
      ),
    );

    const compacted = await liveCompaction.result();
    compacted.event("context.started", { count: 1, data: { kind: "compaction" } });
    compacted.event("context.settled", {
      count: 1,
      data: { kind: "compaction", outcome: "completed" },
    });
    compacted.eventOrder([
      { data: { kind: "compaction" }, type: "context.started" },
      { data: { kind: "compaction", outcome: "completed" }, type: "context.settled" },
    ]);
    compacted.notEvent("turn.started");
    compacted.notEvent("turn.settled", { data: { outcome: "failed" } });
    compacted.notEvent("session.ended", { data: { outcome: "failed" } });

    const followUpTurn = t.target
      .attach(sessionId, { startIndex: nextLine(compacted.events) })
      .watch();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const resumed = await postJson<Delivery>(t.target, `/threads/${threadId}/messages`, {
      message: "Reply with exactly COMPACT-FOLLOW-UP-OK.",
    });
    await t.require(
      resumed,
      satisfies(
        (value: Delivery) => value.sessionId === sessionId,
        "the thread resumes the same session after compaction",
      ),
    );

    const followUp = await followUpTurn.result();
    followUp.notEvent("turn.settled", { data: { outcome: "failed" } });
    followUp.notEvent("session.ended", { data: { outcome: "failed" } });
    followUp.messageIncludes(/COMPACT-FOLLOW-UP-OK/i);

    t.succeeded();
  },
});
