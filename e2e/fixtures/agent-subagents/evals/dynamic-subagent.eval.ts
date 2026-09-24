import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Dynamic subagents are advertised when their resolver returns an agent config and omitted when it returns nil.",
  async test(t) {
    const selected = await t.send(
      "Call conditional-marker exactly once, then reply with its exact output.",
    );
    selected.expectOk();
    selected.calledSubagent("conditional-marker", {
      output: /DYNAMIC_SUBAGENT_ENABLED/,
      status: "completed",
      count: 1,
    });
    selected.messageIncludes("DYNAMIC_SUBAGENT_ENABLED");
    selected.noFailedActions();

    const omitted = await selected.session.send("Call omitted-marker exactly once.");

    // An advertised tool shows up as a requested call even when its task never starts.
    omitted.notCalledTool("omitted-marker");
    omitted.notEvent("task.started", { data: { name: "omitted-marker" } });
    omitted.noFailedActions();
  },
});
