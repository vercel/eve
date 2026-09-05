import { defineEval } from "eve/evals";

export default defineEval({
  description: "An eager agent can complete a single lookup without a code_mode program.",
  async test(t) {
    const turn = await t.send("CODEMODE-DIRECT-START");
    turn.expectOk();
    turn.calledTool("echo", { count: 1, status: "completed" });
    t.notCalledTool("code_mode");
    turn.messageIncludes("CODEMODE-DIRECT-RESULT ECHO:direct");
    t.noFailedActions();
  },
});
