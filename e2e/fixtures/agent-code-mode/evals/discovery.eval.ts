import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Code mode discovers every tool available for direct calls, including their schemas.",
  async test(t) {
    const turn = await t.send("CODEMODE-DISCOVERY-START");
    turn.expectOk();
    turn.calledTool("code_mode", { count: 1, status: "completed" });
    turn.messageIncludes('"complete":true');
    turn.messageIncludes('"schemas":true');
    t.noFailedActions();
  },
});
