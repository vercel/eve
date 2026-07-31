import { defineEval } from "eve/evals";

const PROBE = "dynamic subagent availability probe";

export default defineEval({
  description:
    "Dynamic subagents are advertised when their resolver returns the fallback and omitted when it returns nil.",
  async test(t) {
    await t.send(
      `${PROBE}: Call conditional-marker exactly once, then reply with its exact output. Do not call omitted-marker.`,
    );

    t.succeeded();
    t.calledSubagent("conditional-marker", { count: 1, output: "DYNAMIC_SUBAGENT_ENABLED" });
    t.notEvent("subagent.called", { data: { name: "omitted-marker" } });
    t.messageIncludes("DYNAMIC_SUBAGENT_ENABLED");
    t.messageIncludes("NIL_SUBAGENT_OMITTED");
    t.noFailedActions();
  },
});
