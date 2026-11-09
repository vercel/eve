import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const BOB_REQUEST =
  "Bob asks for the weekly summary in one short sentence. Reply without calling tools.";

export default defineEval({
  description:
    "A person's message waiting when a turn settles runs next, and a hook's ctx.continue() yields to it.",
  timeoutMs: 120_000,
  async test(t) {
    const session = await t.session();
    const held = await session.start(
      "[keep going] Alice asks for a status update. Call hold_turn exactly once, then reply with one short sentence.",
    );
    await held.waitForEvent("call.requested", { data: { capability: { name: "hold_turn" } } });

    // Bob writes while Alice's turn still runs, so his message waits behind it.
    const bob = await session.start(BOB_REQUEST, { turnPolicy: "queue" });

    const alice = await held.result();
    alice.expectOk();
    alice.calledTool("hold_turn", { count: 1, status: "completed" });
    alice.event("turn.settled", { count: 1, data: { outcome: "completed" } });

    const answered = await bob.result();
    answered.expectOk();
    // Bob's turn is the only one to start after he wrote: the hook's continuation never ran.
    answered.event("turn.started", { count: 1 });
    answered.notEvent("delivery.admitted", { data: { source: { hook: "keep-going" } } });
    const consumed = answered.events.flatMap((event) =>
      event.type === "delivery.consumed"
        ? [event.data.parts.map((part) => (part.kind === "text" ? part.text : "")).join("")]
        : [],
    );
    await t.require(consumed.at(-1), equals(BOB_REQUEST));

    // Bob's turn dropped the continuation, so nothing starts after it either.
    const after = session.watch({ startIndex: session.state.streamIndex });
    const late = await Promise.race([
      after.waitForEvent("delivery.admitted").catch(() => undefined),
      t.sleep(5_000).then(() => undefined),
    ]);
    await t.require(late?.data.source, equals(undefined));
    t.succeeded();
  },
});
