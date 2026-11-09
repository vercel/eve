import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Changing dynamic declarations outside memos do not fail the turn; later evaluations can omit them again.",
  async test(t) {
    const session = await t.session();
    const auth = { authorization: "Bearer workspace-carol" };

    const first = await session.send(
      "[lucky] Carol requests a one-sentence status update without calling tools.",
      { headers: auth },
    );
    first.expectOk();
    first.usedNoTools();
    first.notEvent("session.ended");

    const next = await session.send(
      "Carol requests another one-sentence status update without calling tools.",
      { headers: auth },
    );
    next.expectOk();
    next.event("turn.settled", { count: 1, data: { outcome: "completed" } });
  },
});
