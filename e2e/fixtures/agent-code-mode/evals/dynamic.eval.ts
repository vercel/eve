import { defineEval } from "eve/evals";

export default defineEval({
  description: "Code mode executes a unique dynamic tool and selects the narrowest override.",
  async test(t) {
    const turn = await t.send("CODEMODE-DYNAMIC-START");
    turn.expectOk();
    turn.calledTool("code_mode", { count: 1, status: "completed" });
    turn.messageIncludes('"shared":"step"');
    turn.messageIncludes('"discovered":"discovered"');
    t.noFailedActions();
  },
});
