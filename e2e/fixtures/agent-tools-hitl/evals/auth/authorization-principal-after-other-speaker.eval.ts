import { defineEval } from "eve/evals";

const ALICE = "principal-binding-alice";
const BOB = "principal-binding-bob";
const as = (principalId: string) => ({ headers: { "x-eve-fixture-user": principalId } });

/**
 * Alice starts a sign-in, which holds her turn. Bob posts in the same session
 * before Alice finishes, so his message queues behind her held turn. Alice's
 * completion resumes her turn as Alice, and Bob's message runs after it.
 */
export default defineEval({
  description: "A sign-in holds Alice's turn; Bob's message waits behind it and runs after.",
  async test(t) {
    const started = await t.send(
      'Call the auth-probe tool exactly once with marker "principal-binding".',
      as(ALICE),
    );
    const session = started.session;
    started.event("authorization.required", { count: 1, data: { principalId: ALICE } });
    started.event("turn.waiting", { count: 1 });
    started.notEvent("session.waiting");
    const required = started.events.find((event) => event.type === "authorization.required");
    if (
      required?.type !== "authorization.required" ||
      required.data.authorization?.url === undefined
    )
      throw new Error("Expected Alice's sign-in challenge URL.");

    const resumed = t.target.watchTurn(session.sessionId, {
      startIndex: session.state?.streamIndex,
    });
    const bob = await session.start(
      "Do not call any tools. Reply with exactly BOB-STATUS-OK.",
      as(BOB),
    );
    const callbackUrl = new URL(required.data.authorization.url);
    const callback = await t.target.fetch(`${callbackUrl.pathname}${callbackUrl.search}`);
    if (!callback.ok) throw new Error(`Fixture sign-in callback failed (${callback.status}).`);

    const completed = await resumed.result();
    completed.event("authorization.completed", {
      count: 1,
      data: { attemptId: required.data.attemptId, outcome: "authorized", principalId: ALICE },
    });
    completed.notEvent("turn.started");

    const bobTurn = await bob.result();
    bobTurn.expectOk();
    bobTurn.messageIncludes("BOB-STATUS-OK");
    bobTurn.notEvent("authorization.required");
  },
});
