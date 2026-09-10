import { defineEval } from "eve/evals";

export default defineEval({
  description: "Nested file and todo updates survive suspension and reach the next parent turn.",
  timeoutMs: 120_000,
  async test(t) {
    const program = await t.send("CODEMODE-STATE-START");
    program.expectOk();
    program.calledTool("code_mode", { count: 1, status: "completed" });
    program.messageIncludes("CODEMODE-PERSISTED-TODO");
    program.messageIncludes("CODEMODE-PERSISTED-FILE");
    const parent = await t.send("CODEMODE-STATE-READ");
    parent.expectOk();
    parent.calledTool("todo", { count: 1, status: "completed" });
    parent.messageIncludes("CODEMODE-PERSISTED-TODO");
    t.noFailedActions();
  },
});
