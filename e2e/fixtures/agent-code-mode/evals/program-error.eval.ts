import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "An invalid program reaches the model as a tool error and a corrected program succeeds.",
  async test(t) {
    const turn = await t.send("CODEMODE-PROGRAM-ERROR-START");
    turn.expectOk();
    turn.calledTool("code_mode", { count: 1, status: "failed" });
    turn.calledTool("code_mode", { count: 1, status: "completed" });
    turn.messageIncludes("CODEMODE-PROGRAM-ERROR-RESULT ECHO:corrected");
  },
});
