import { defineEval } from "eve/evals";

export default defineEval({
  description: "A bundled workflow webhook accepts a public callback and preserves its response.",
  async test(t) {
    const turn = await t.send("WORKFLOW-WEBHOOK-START");
    turn.expectOk();
    turn.calledTool("webhook_deploy", { output: /"callback":\{"service":"api"\}/u });
    turn.messageIncludes("WORKFLOW-WEBHOOK-RESULT");
    t.noFailedActions();
  },
});
