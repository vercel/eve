import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Dynamic subagents are advertised when their resolver returns an agent config and omitted when it returns nil.",
  async test(t) {
    const selected = await t.send("Call conditional-marker exactly once.");
    selected.expectOk();
    selected.calledSubagent("conditional-marker", { count: 1 });
    selected.messageIncludes("DYNAMIC_SUBAGENT_ENABLED");

    const omitted = await selected.session.send("Call omitted-marker exactly once.");

    omitted.notEvent("task.started", { data: { name: "omitted-marker" } });
    omitted.noFailedActions();
  },
});
