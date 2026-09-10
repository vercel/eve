import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A program awaits an authored workflow tool, whose body runs inside the program's run, and chains its result.",
  async test(t) {
    const turn = await t.send("CODEMODE-WORKFLOW-START");
    turn.expectOk();
    turn.calledTool("code_mode", { count: 1, status: "completed" });
    turn.messageIncludes("CODEMODE-WORKFLOW-RESULT");
    turn.messageIncludes('"plan":"PLAN:CODEMODE-WF"');
    turn.messageIncludes("ECHO:PLAN:CODEMODE-WF");
    t.noFailedActions();
  },
});
