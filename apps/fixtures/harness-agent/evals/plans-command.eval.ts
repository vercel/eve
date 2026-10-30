import { defineEval } from "eve/evals";

export default defineEval({
  description: "/plans settles without the model, with the harness's own reply.",
  async test(t) {
    const turn = await t.send("/plans");

    turn.expectOk();
    turn.messageIncludes("enterprise: 500 seats");
    turn.event("model.requested", { count: 0 });
    t.succeeded();
  },
});
