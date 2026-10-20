import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Dynamic subagents are advertised when their resolver returns an agent config and omitted when it returns nil.",
  async test(t) {
    const selected = await t.send("E2E_DYNAMIC_SUBAGENT_CATALOG");
    selected.expectOk();
    selected.calledSubagent("conditional-marker", { count: 1 });
    selected.messageIncludes("DYNAMIC_SUBAGENT_ENABLED");
    selected.notEvent("child.opened", { data: { name: "omitted-marker" } });
    selected.noFailedActions();
  },
});
