import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Dynamic subagents are advertised when their resolver returns an agent config and omitted when it returns nil.",
  async test(t) {
    const selected = await t.send("Call conditional-marker.");
    selected.expectOk();
    // Availability, not the model's delegation count, is the contract here.
    selected.calledSubagent("conditional-marker");
    selected.noFailedActions();
    selected.notEvent("task.settled", {
      data: { name: "conditional-marker", status: (status) => status !== "completed" },
    });
    selected.messageIncludes("DYNAMIC_SUBAGENT_ENABLED");

    const omitted = await selected.session.send("Call omitted-marker exactly once.");

    omitted.notEvent("task.started", { data: { name: "omitted-marker" } });
    omitted.noFailedActions();
  },
});
