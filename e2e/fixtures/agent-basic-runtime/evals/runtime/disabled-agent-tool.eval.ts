import { defineEval } from "eve/evals";

export default defineEval({
  description: "A same-named disableTool file removes the root built-in agent tool.",
  async test(t) {
    const turn = await t.send("E2E_DISABLED_ROOT_AGENT_TOOL");

    turn.expectOk();
    turn.messageIncludes("DISABLED-ROOT-AGENT-TOOL-HIDDEN");
    turn.calledAgent("agent", { count: 0 });
    t.succeeded();
    t.noFailedCalls();
  },
});
