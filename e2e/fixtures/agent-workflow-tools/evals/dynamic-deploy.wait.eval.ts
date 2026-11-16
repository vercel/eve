import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A workflow tool returned by defineDynamic parks the turn through a step, then its return value settles the call.",
  async test(t) {
    const turn = await t.send("WORKFLOW-DYNAMIC-START");
    turn.expectOk();
    turn.calledTool("dynamic_deploy", {
      output: /"plan":"deploy api"/u,
    });
    turn.calledTool("dynamic_deploy", {
      output: /"tool":"dynamic_deploy"/u,
    });
    turn.messageIncludes("WORKFLOW-DYNAMIC-RESULT");
    turn.messageIncludes("deploy api");
    t.noFailedCalls();
  },
});
