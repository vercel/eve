import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A program threads one nested call's output into the next; each call settles on its own step.",
  timeoutMs: 60_000,
  async test(t) {
    const turn = await t.send("CODEMODE-CHAIN-START");
    turn.expectOk();
    turn.calledTool("code_mode", { count: 1, status: "completed" });
    turn.messageIncludes("CODEMODE-CHAIN-RESULT ECHO:ECHO:one");
    t.noFailedActions();
  },
});
