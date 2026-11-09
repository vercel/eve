import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A hook that throws after its turn settles fails nothing: the turn stays completed, and the next turn runs.",
  async test(t) {
    const session = await t.session();
    const auth = { authorization: "Bearer workspace-carol" };

    const first = await session.send(
      "[notify: unavailable] Carol asks for a one-sentence status update. Reply without calling tools.",
      { headers: auth },
    );
    first.expectOk();
    first.event("turn.settled", { count: 1, data: { outcome: "completed" } });
    first.notEvent("session.ended");

    const next = await session.send(
      "Carol asks for another one-sentence status update. Reply without calling tools.",
      { headers: auth },
    );
    next.expectOk();
    next.event("turn.settled", { count: 1, data: { outcome: "completed" } });
    next.notEvent("session.ended");
  },
});
