import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "code_mode rejects the third subagent call once experimental.codeMode.maxSubagents (2) is spent.",
  async test(t) {
    await t.send("CODEMODE-LIMIT-START");
    t.succeeded();
    t.calledTool("code_mode", { count: 1 });
    t.calledSubagent("marker", { count: 2 });
    t.messageIncludes("MARKER:limit-alpha");
    t.messageIncludes("MARKER:limit-beta");
    t.messageIncludes("CODE_MODE_SUBAGENT_LIMIT_REACHED");
  },
});
