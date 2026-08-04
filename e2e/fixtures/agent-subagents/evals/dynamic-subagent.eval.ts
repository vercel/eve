import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Dynamic subagents are advertised when their resolver returns an agent config and omitted when it returns nil.",
  async test(t) {
    const selected = await t.send({ message: "Call conditional-marker exactly once." });

    selected.calledSubagent("conditional-marker", {
      count: 1,
      output: "DYNAMIC_SUBAGENT_ENABLED",
    });
    selected.messageIncludes("DYNAMIC_SUBAGENT_ENABLED");
    selected.noFailedActions();

    const omitted = await t.send({ message: "Call omitted-marker exactly once." });

    omitted.notEvent("subagent.called", { data: { name: "omitted-marker" } });
    omitted.noFailedActions();
  },
});
