import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

interface MessageResponse {
  readonly ok: boolean;
  readonly sessionId?: string;
}

interface ClearResponse {
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

/** Clears a parked conversation through a custom channel route. */
export default defineEval({
  description: "Clear custom-channel context without replacing the durable session.",
  timeoutMs: 240_000,

  async test(t) {
    const unknownThread = await postJson<ClearResponse>(
      t.target,
      `/threads/${crypto.randomUUID()}/clear`,
      {},
    );
    await t.require(
      unknownThread,
      satisfies(
        (value: ClearResponse) => value.status === "no_active_session",
        "clearing an unknown thread reports no_active_session",
      ),
    );

    const threadId = crypto.randomUUID();
    const started = await postJson<MessageResponse>(t.target, `/threads/${threadId}/messages`, {
      message: "Reply with exactly CLEAR-INITIAL-OK.",
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

    const liveClear = t.target.watchTurn(sessionId, { startIndex: initial.events.length });
    const clearedResponse = await postJson<ClearResponse>(
      t.target,
      `/threads/${threadId}/clear`,
      {},
    );
    await t.require(
      clearedResponse,
      satisfies(
        (value: ClearResponse) => value.status === "accepted" && value.sessionId === sessionId,
        "the channel accepts a clear for the active session",
      ),
    );

    const cleared = await liveClear.result();
    cleared.event("context.cleared", { count: 1 });
    cleared.eventOrder([{ type: "context.cleared" }, { type: "session.waiting" }]);
    cleared.notEvent("turn.started");
    cleared.notEvent("turn.failed");
    cleared.notEvent("session.failed");

    const resumed = await postJson<MessageResponse>(t.target, `/threads/${threadId}/messages`, {
      message: "Reply with exactly CLEAR-FOLLOW-UP-OK.",
    });
    await t.require(
      resumed,
      satisfies(
        (value: MessageResponse) => value.sessionId === sessionId,
        "the thread resumes the same session after clearing context",
      ),
    );

    const followUp = await t.target
      .watchTurn(sessionId, {
        startIndex: initial.events.length + cleared.events.length,
      })
      .result();
    followUp.notEvent("turn.failed");
    followUp.notEvent("session.failed");
    followUp.messageIncludes(/CLEAR-FOLLOW-UP-OK/i);

    t.succeeded();
  },
});
