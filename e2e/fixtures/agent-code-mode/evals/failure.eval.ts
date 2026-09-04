import { defineEval } from "eve/evals";

export default defineEval({
  description: "A failed subagent settles as a rejected promise and the program can call it again.",
  async test(t) {
    const turn = await t.send("CODEMODE-FAILURE-START");
    turn.expectOk();
    turn.calledTool("code_mode", { count: 1, status: "completed" });
    turn.messageIncludes('"statuses":["rejected","fulfilled"]');
    turn.messageIncludes('"sibling":"ECHO:sibling"');
    turn.messageIncludes('"retry":"MARKER:retry-ok"');
  },
});
