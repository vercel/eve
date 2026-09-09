import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "An imported workflow executor parks the turn through a step and a sleep, then its return value settles the call.",
  async test(t) {
    const turn = await t.send("WORKFLOW-DEPLOY-START");
    turn.expectOk();
    turn.calledTool("deploy_service", {
      output: /"plan":"deploy api"/u,
    });
    turn.calledTool("deploy_service", {
      output: /"tool":"deploy_service"/u,
    });
    turn.messageIncludes("WORKFLOW-DEPLOY-RESULT");
    turn.messageIncludes("deploy api");
    t.noFailedActions();
  },
});
