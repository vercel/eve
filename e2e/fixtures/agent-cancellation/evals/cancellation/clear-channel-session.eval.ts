import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

interface Delivery {
  readonly ok: boolean;
  readonly sessionId?: string;
}

interface ClearResponse {
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

/** Clears a parked conversation through a custom channel route. */
export default defineEval({
  description: "Clear custom-channel context without replacing the durable session.",
  timeoutMs: 240_000,

  async test(t) {
    const unknownThread = await postJson<ClearResponse>(
      t.target,
      `/threads/${crypto.randomUUID()}/clear`,
      {},
      409,
    );
    await t.require(
      unknownThread,
      satisfies(
        (value: ClearResponse) => value.code === "session_not_active",
        "clearing an unknown thread reports session_not_active",
      ),
    );

    const threadId = crypto.randomUUID();
    const started = await postJson<Delivery>(t.target, `/threads/${threadId}/messages`, {
      message: "Reply with exactly CLEAR-INITIAL-OK.",
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
    const liveClear = t.target
      .attach(sessionId, { startIndex: nextLine(initial.events) })
      .watch({ until: (event) => event.type === "context.settled" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const clearedResponse = await postJson<ClearResponse>(
      t.target,
      `/threads/${threadId}/clear`,
      {},
    );
    await t.require(
      clearedResponse,
      satisfies(
        (value: ClearResponse) =>
          typeof value.deliveryId === "string" && value.sessionId === sessionId,
        "the channel accepts a clear for the active session",
      ),
    );

    const cleared = await liveClear.result();
    cleared.event("context.settled", { count: 1, data: { kind: "clear", outcome: "completed" } });
    cleared.eventOrder([
      { data: { kind: "clear", outcome: "completed" }, type: "context.settled" },
    ]);
    cleared.notEvent("turn.started");
    cleared.notEvent("turn.settled", { data: { outcome: "failed" } });
    cleared.notEvent("session.ended", { data: { outcome: "failed" } });

    const followUpTurn = t.target
      .attach(sessionId, { startIndex: nextLine(cleared.events) })
      .watch();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const resumed = await postJson<Delivery>(t.target, `/threads/${threadId}/messages`, {
      message: "Reply with exactly CLEAR-FOLLOW-UP-OK.",
    });
    await t.require(
      resumed,
      satisfies(
        (value: Delivery) => value.sessionId === sessionId,
        "the thread resumes the same session after clearing context",
      ),
    );

    const followUp = await followUpTurn.result();
    followUp.notEvent("turn.settled", { data: { outcome: "failed" } });
    followUp.notEvent("session.ended", { data: { outcome: "failed" } });
    followUp.messageIncludes(/CLEAR-FOLLOW-UP-OK/i);

    t.succeeded();
  },
});
