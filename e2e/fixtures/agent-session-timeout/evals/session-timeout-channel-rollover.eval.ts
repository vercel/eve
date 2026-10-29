import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

interface Delivery {
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
    "Session idle timeout waits out an active turn, then the same channel thread starts a new session.",

  async test(t) {
    const threadId = crypto.randomUUID();
    const initial = await postJson<Delivery>(t.target, `/threads/${threadId}/messages`, {
      message: "SLOW-TURN",
    });
    await t.require(
      initial,
      satisfies(
        (value: Delivery) => typeof value.sessionId === "string",
        "the channel starts the initial session",
      ),
    );
    const expiredSessionId = initial.sessionId!;

    const activeTurn = await t.target.attach(expiredSessionId).watch().result();
    activeTurn.expectOk();
    activeTurn.notEvent("turn.settled", { data: { outcome: "failed" } });
    await t.require(activeTurn.reply, equals("timeout-ack:SLOW-TURN"));

    const terminal = await t.target
      .attach(expiredSessionId, { startIndex: activeTurn.session.state!.streamIndex })
      .watch()
      .result();
    await t.require(terminal.status, equals("completed"));
    terminal.event("session.ended", { data: { outcome: "completed" } });
    terminal.notEvent("turn.settled", { data: { outcome: "failed" } });
    terminal.notEvent("session.ended", { data: { outcome: "failed" } });

    let owner: OwnerResponse = { sessionId: expiredSessionId };
    for (let attempt = 0; attempt < 50 && owner.sessionId !== null; attempt += 1) {
      owner = await postJson<OwnerResponse>(t.target, `/threads/${threadId}/owner`, {});
      if (owner.sessionId !== null) {
        await t.sleep(100);
      }
    }
    await t.require(owner.sessionId, equals(null));

    const replacement = await postJson<Delivery>(t.target, `/threads/${threadId}/messages`, {
      message: "REPLACEMENT-TURN",
    });
    await t.require(
      replacement,
      satisfies(
        (value: Delivery) =>
          typeof value.sessionId === "string" && value.sessionId !== expiredSessionId,
        "the expired channel thread starts a fresh session",
      ),
    );

    const replacementTurn = await t.target.attach(replacement.sessionId!).watch().result();
    replacementTurn.expectOk();
    replacementTurn.notEvent("turn.settled", { data: { outcome: "failed" } });
    replacementTurn.notEvent("session.ended", { data: { outcome: "failed" } });
    await t.require(replacementTurn.reply, equals("timeout-ack:REPLACEMENT-TURN"));
  },
});
