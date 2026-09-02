import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Two waiting workflow tools dispatched by one model step run in parallel and both results resume the agent.",
  async test(t) {
    const turn = await t.send("WORKFLOW-PARALLEL-START");
    turn.expectOk();
    turn.calledTool("deploy_service", { output: /"plan":"deploy api"/u });
    turn.calledTool("deploy_service", { output: /"plan":"deploy web"/u });
    turn.messageIncludes("WORKFLOW-PARALLEL-RESULT");
    turn.messageIncludes("deploy api");
    turn.messageIncludes("deploy web");
    t.noFailedActions();
  },
});
