import { defineEval } from "eve/evals";

export default defineEval({
  description: "/seats calls plan_lookup from the harness and settles without the model.",
  async test(t) {
    const turn = await t.send("/seats enterprise");

    turn.expectOk();
    turn.messageIncludes("The enterprise plan has 500 seats.");
    turn.event("model.requested", { count: 0 });
    turn.calledTool("plan_lookup");
    t.succeeded();
  },
});
