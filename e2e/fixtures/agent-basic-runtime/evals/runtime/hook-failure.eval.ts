import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A hook that throws during a turn fails that turn before its model call, and the next turn runs.",
  async test(t) {
    const session = await t.session();
    const auth = { authorization: "Bearer workspace-carol" };

    const failed = await session.send("[policy: unavailable] Carol asks for a status update.", {
      headers: auth,
    });
    failed.eventsSatisfy("the hook's error fails the turn", (events) =>
      events.some(
        (event) =>
          event.type === "turn.settled" &&
          event.data.outcome === "failed" &&
          event.data.error?.message.includes("The policy service is unavailable.") === true,
      ),
    );
    failed.notEvent("session.ended");
    failed.usedNoTools();

    const next = await session.send(
      "Carol asks for a one-sentence status update. Reply without calling tools.",
      { headers: auth },
    );
    next.expectOk();
    next.event("turn.settled", { count: 1, data: { outcome: "completed" } });
  },
});
