import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { KEEP_GOING_CONTINUATION } from "../../agent/lib/keep-going";

export default defineEval({
  description:
    "A turn.settled hook's ctx.continue() starts the session's next turn as a delivery from the hook.",
  timeoutMs: 120_000,
  async test(t) {
    const session = await t.session();
    const first = await session.send(
      "[keep going] Alice asks for a one-sentence status update. Reply without calling tools.",
    );
    first.expectOk();
    first.event("turn.settled", { count: 1, data: { outcome: "completed" } });

    // No one sends anything: the hook starts the next turn on its own.
    const next = await session.nextTurn({ startIndex: session.state.streamIndex });
    next.expectOk();
    next.event("delivery.admitted", { count: 1, data: { source: { hook: "keep-going" } } });
    next.event("turn.settled", { count: 1, data: { outcome: "completed" } });
    const consumed = next.events.flatMap((event) =>
      event.type === "delivery.consumed"
        ? event.data.parts.map((part) => (part.kind === "text" ? part.text : ""))
        : [],
    );
    await t.require(consumed, equals([KEEP_GOING_CONTINUATION]));
    if (process.env.EVE_E2E_MODEL === "mock") {
      // The deterministic model replies this only when history notes no person sent the message.
      next.messageIncludes("KEEP-GOING-CONTINUATION-NOTED");
    }
    t.succeeded();
  },
});
