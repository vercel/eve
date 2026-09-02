import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A workflow tool result leads to another workflow tool call before the batched agent turn completes.",
  async test(t) {
    const turn = await t.send("WORKFLOW-CHAIN-START");
    turn.expectOk();
    turn.calledTool("deploy_service", { output: /"plan":"deploy api"/u });
    turn.calledTool("deploy_service", { output: /"plan":"deploy web"/u });
    turn.messageIncludes("WORKFLOW-CHAIN-RESULT");
    turn.messageIncludes("deploy api");
    turn.messageIncludes("deploy web");
    t.noFailedActions();
  },
});
