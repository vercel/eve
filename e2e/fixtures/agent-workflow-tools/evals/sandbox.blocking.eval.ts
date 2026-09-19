import { defineEval } from "eve/evals";

export default defineEval({
  description: "A blocking workflow reconnects to the same sandbox after a durable wait.",
  async test(t) {
    const turn = await t.send("WORKFLOW-SANDBOX-BLOCKING-START");
    turn.expectOk();
    turn.calledTool("sandbox_blocking", { status: "completed", count: 1 });
    turn.messageIncludes('"content":"workflow-sandbox:api"');
    turn.messageIncludes('"sameSandbox":true');
    turn.messageIncludes('"commandExitCode":0');
    t.noFailedActions();
  },
});
