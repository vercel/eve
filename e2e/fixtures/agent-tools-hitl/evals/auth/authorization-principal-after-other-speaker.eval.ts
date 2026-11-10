import { defineEval } from "eve/evals";

const ALICE = "principal-binding-alice";
const BOB = "principal-binding-bob";
const BOB_MESSAGE = "Do not call any tools. Reply with exactly BOB-STATUS-OK.";
const as = (principalId: string) => ({ headers: { "x-eve-fixture-user": principalId } });

/**
 * Alice starts a sign-in, which holds her turn. Bob posts in the same session
 * before Alice finishes, so his message waits for the sign-in. Alice's
 * completion resumes her turn as Alice, and Bob's message then joins it.
 */
export default defineEval({
  description: "A sign-in holds Alice's turn; Bob's message waits for it, then joins her turn.",
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
    const url =
      required?.type === "interaction.opened" ? required.data.request.signIn?.url : undefined;
    if (required?.type !== "interaction.opened" || url === undefined)
      throw new Error("Expected Alice's sign-in challenge URL.");

    const resumed = t.target.attach(session.id, { startIndex: session.state?.streamIndex }).watch();
    await session.start(BOB_MESSAGE, as(BOB));
    const callbackUrl = new URL(url);
    const callback = await t.target.fetch(`${callbackUrl.pathname}${callbackUrl.search}`);
    if (!callback.ok) throw new Error(`Fixture sign-in callback failed (${callback.status}).`);

    const completed = await resumed.result();
    completed.event("interaction.settled", {
      count: 1,
      data: { interactionId: required.data.interactionId, outcome: "accepted" },
    });
    completed.notEvent("turn.started");
    // The auth-probe call ran as Alice before Bob's message joined; the model then answers Bob.
    completed.event("delivery.consumed", {
      count: 1,
      data: { parts: [{ kind: "text", text: BOB_MESSAGE }] },
    });
    completed.messageIncludes("BOB-STATUS-OK");
    completed.notEvent("interaction.opened", { data: { request: { kind: "sign-in" } } });
  },
});
