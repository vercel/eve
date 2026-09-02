import { defineEval } from "eve/evals";

/**
 * A workflow body starts a fan-out of child runs through a `start` step and
 * collects their results on reply hooks. Both replicas come back.
 */
export default defineEval({
  description: "A workflow tool starts child workflow runs and combines their results.",
  async test(t) {
    const turn = await t.send("WORKFLOW-FANOUT-START");
    turn.expectOk();
    turn.calledTool("fanout_deploy", { output: /"replica":0/u });
    turn.calledTool("fanout_deploy", { output: /"replica":1/u });
    turn.messageIncludes("WORKFLOW-FANOUT-RESULT");
    t.noFailedActions();
  },
});
