import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

interface MessageResponse {
  readonly sessionId?: string;
}

interface OwnerResponse {
  readonly sessionId: string | null;
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

export default defineEval({
  description:
    "Session TTL lets an active turn settle, then the same channel thread starts a new session.",

  async test(t) {
    const threadId = crypto.randomUUID();
    const initial = await postJson<MessageResponse>(t.target, `/threads/${threadId}/messages`, {
      message: "SLOW-TURN",
    });
    await t.require(
      initial,
      satisfies(
        (value: MessageResponse) => typeof value.sessionId === "string",
        "the channel starts the initial session",
      ),
    );
    const expiredSessionId = initial.sessionId!;

    const activeTurn = await t.target.watchTurn(expiredSessionId).result();
    activeTurn.expectOk();
    activeTurn.notEvent("turn.failed");
    await t.require(activeTurn.message, equals("timeout-ack:SLOW-TURN"));

    const terminal = await t.target
      .watchTurn(expiredSessionId, { startIndex: activeTurn.events.length })
      .result();
    await t.require(terminal.status, equals("completed"));
    terminal.event("session.completed");
    terminal.notEvent("turn.failed");
    terminal.notEvent("session.failed");

    await t.eventually(
      async () =>
        (await postJson<OwnerResponse>(t.target, `/threads/${threadId}/owner`, {})).sessionId,
      equals(null),
    );

    const replacement = await postJson<MessageResponse>(t.target, `/threads/${threadId}/messages`, {
      message: "REPLACEMENT-TURN",
    });
    await t.require(
      replacement,
      satisfies(
        (value: MessageResponse) =>
          typeof value.sessionId === "string" && value.sessionId !== expiredSessionId,
        "the expired channel thread starts a fresh session",
      ),
    );

    const replacementTurn = await t.target.watchTurn(replacement.sessionId!).result();
    replacementTurn.expectOk();
    replacementTurn.notEvent("turn.failed");
    replacementTurn.notEvent("session.failed");
    await t.require(replacementTurn.message, equals("timeout-ack:REPLACEMENT-TURN"));
  },
});
