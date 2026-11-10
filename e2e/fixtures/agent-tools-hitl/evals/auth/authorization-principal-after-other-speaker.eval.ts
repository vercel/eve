import { defineEval } from "eve/evals";

const ALICE = "principal-binding-alice";
const BOB = "principal-binding-bob";
const BOB_MESSAGE = "Do not call any tools. Reply with exactly BOB-STATUS-OK.";
const as = (principalId: string) => ({ headers: { "x-eve-fixture-user": principalId } });

/**
 * Alice starts a sign-in, which holds her turn. Bob posts in the same session before Alice
 * finishes, and his message joins her turn while the sign-in stays open. Alice's completion then
 * runs her call as Alice, though Bob spoke last.
 */
export default defineEval({
  description:
    "Bob's message joins Alice's turn during her sign-in, and her call still runs as her.",
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

    // Bob sends as a channel does by default, so his message joins the running turn.
    const joined = await session.send(BOB_MESSAGE, { ...as(BOB), turnPolicy: "steer" });
    joined.notEvent("turn.started");
    joined.event("delivery.consumed", {
      count: 1,
      data: { parts: [{ kind: "text", text: BOB_MESSAGE }] },
    });
    joined.messageIncludes("BOB-STATUS-OK");
    joined.notEvent("interaction.settled", {
      data: { interactionId: required.data.interactionId },
    });
    joined.notEvent("turn.settled");

    const resumed = t.target.attach(session.id, { startIndex: session.state?.streamIndex }).watch();
    const callbackUrl = new URL(url);
    const callback = await t.target.fetch(`${callbackUrl.pathname}${callbackUrl.search}`);
    if (!callback.ok) throw new Error(`Fixture sign-in callback failed (${callback.status}).`);

    const completed = await resumed.result();
    completed.event("interaction.settled", {
      count: 1,
      data: { interactionId: required.data.interactionId, outcome: "accepted" },
    });
    completed.notEvent("turn.started");
    completed.calledTool("auth-probe", { status: "completed", output: { actor: ALICE }, count: 1 });
    completed.notEvent("interaction.opened", { data: { request: { kind: "sign-in" } } });
    completed.event("turn.settled", { count: 1, data: { outcome: "completed" } });
  },
});
