import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description: "An authored workflow opens a root copy with a model override.",
  async test(t) {
    const turn = await t.send(
      "E2E_MODEL_OVERRIDE_ROOT_COPY Alice asks a root copy to review a sample plan.",
    );

    turn.expectOk();
    turn.calledTool("invoke-self-with-model", { count: 1 });
    turn.event("agent.started", { count: 1, data: { name: "agent" } });
    t.succeeded();
    t.noFailedActions();
  },
});
