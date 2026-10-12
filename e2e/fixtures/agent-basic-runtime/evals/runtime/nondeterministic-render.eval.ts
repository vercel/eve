import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "In development, a render that isn't deterministic fails its turn with how to fix it, and the next turn runs once it renders nothing.",
  async test(t) {
    const session = await t.session();
    const auth = { authorization: "Bearer workspace-carol" };

    const failed = await session.send("[lucky] Carol asks for a lucky number.", { headers: auth });
    failed.eventsSatisfy("the nondeterministic render fails the turn", (events) =>
      events.some(
        (event) =>
          event.type === "turn.settled" &&
          event.data.outcome === "failed" &&
          event.data.error?.message.includes("render must be deterministic") === true,
      ),
    );
    failed.usedNoTools();
    failed.notEvent("session.ended");

    const next = await session.send(
      "Carol asks for a one-sentence status update. Reply without calling tools.",
      { headers: auth },
    );
    next.expectOk();
    next.event("turn.settled", { count: 1, data: { outcome: "completed" } });
  },
});
