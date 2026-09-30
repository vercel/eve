import { defineEval } from "eve/evals";

const ALICE = "principal-binding-alice";
const BOB = "principal-binding-bob";
const as = (principalId: string) => ({ headers: { "x-eve-fixture-user": principalId } });

/**
 * Alice starts a sign-in, then Bob posts in the same session before Alice
 * finishes. Bob is now the session's latest caller, so a channel that picks
 * the recipient from the current caller would send Alice's challenge or
 * completion status to Bob. Both events name Alice instead.
 */
export default defineEval({
  description: "A sign-in stays bound to the person who started it after someone else speaks.",
  async test(t) {
    const started = await t.send(
      'Call the auth-probe tool exactly once with marker "principal-binding".',
      as(ALICE),
    );
    const session = started.session;
    started.event("authorization.required", { count: 1, data: { principalId: ALICE } });
    started.event("session.waiting", { count: 1 });
    const required = started.events.find((event) => event.type === "authorization.required");
    if (
      required?.type !== "authorization.required" ||
      required.data.authorization?.url === undefined
    )
      throw new Error("Expected Alice's sign-in challenge URL.");

    const bob = await session.send(
      "Do not call any tools. Reply with exactly BOB-STATUS-OK.",
      as(BOB),
    );
    bob.expectOk();
    bob.messageIncludes("BOB-STATUS-OK");
    bob.notEvent("authorization.required");
    bob.notEvent("authorization.completed");

    const callbackTurn = t.target.watchTurn(session.sessionId, {
      startIndex: session.state?.streamIndex,
    });
    const callback = await fetch(new URL(required.data.authorization.url));
    if (!callback.ok) throw new Error(`Fixture sign-in callback failed (${callback.status}).`);
    const completed = await callbackTurn.result();
    completed.event("authorization.completed", {
      count: 1,
      data: { attemptId: required.data.attemptId, outcome: "authorized", principalId: ALICE },
    });
  },
});
