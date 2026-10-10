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
    started.event("interaction.opened", {
      count: 1,
      data: { audience: { principalIds: [ALICE] }, request: { kind: "sign-in" } },
    });
    started.event("turn.paused", { count: 1 });
    started.notEvent("turn.settled");
    const required = started.events.find(
      (event) => event.type === "interaction.opened" && event.data.request.kind === "sign-in",
    );
    const url = required?.type === "interaction.opened" ? required.data.request.signIn?.url : undefined;
    if (required?.type !== "interaction.opened" || url === undefined)
      throw new Error("Expected Alice's sign-in challenge URL.");

    const resumed = t.target.watchTurn(session.sessionId, {
      startIndex: session.state?.streamIndex,
    });
    const bob = await session.start(
      "Do not call any tools. Reply with exactly BOB-STATUS-OK.",
      as(BOB),
    );
    const callback = await fetch(new URL(url));
    if (!callback.ok) throw new Error(`Fixture sign-in callback failed (${callback.status}).`);

    const completed = await resumed.result();
    completed.event("interaction.settled", {
      count: 1,
      data: { interactionId: required.data.interactionId, outcome: "accepted" },
    });
    completed.notEvent("turn.started");

    const bobTurn = await bob.result();
    bobTurn.expectOk();
    bobTurn.messageIncludes("BOB-STATUS-OK");
    bobTurn.notEvent("interaction.opened", { data: { request: { kind: "sign-in" } } });
  },
});
