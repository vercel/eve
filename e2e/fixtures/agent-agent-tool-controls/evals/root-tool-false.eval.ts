import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "The root can hide its built-in agent tool while an authored workflow still invokes it.",
  async test(t) {
    const turn = await t.send("Verify the root agent tool surface.");

    turn.expectOk();
    turn.messageIncludes("INTERNAL-ROOT-COPY-OK");
    turn.calledTool("invoke-self", { count: 1 });
    turn.calledSubagent("agent", { count: 1, status: "completed" });
    t.succeeded();
    t.noFailedActions();
  },
});
