import { defineEval } from "eve/evals";

export default defineEval({
  description: "code_mode runs one program that calls an ordinary tool and returns its value.",
  timeoutMs: 60_000,
  async test(t) {
    const turn = await t.send("CODEMODE-ECHO-START");
    turn.expectOk();
    turn.calledTool("code_mode", { count: 1, status: "completed" });
    turn.messageIncludes("CODEMODE-ECHO-RESULT ECHO:hello");
    t.noFailedActions();
  },
});
