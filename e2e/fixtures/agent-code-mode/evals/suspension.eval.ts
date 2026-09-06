import { defineEval } from "eve/evals";

export default defineEval({
  description: "Suspending a tool call inside try/finally preserves normal completion and cleanup.",
  async test(t) {
    const turn = await t.send("CODEMODE-SUSPENSION-START");
    turn.expectOk();
    turn.calledTool("code_mode", { count: 1, status: "completed" });
    turn.messageIncludes('"result":"ECHO:suspended"');
    turn.messageIncludes('"cleanup":"ECHO:cleanup"');
    t.noFailedActions();
  },
});
