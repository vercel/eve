import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "code_mode rejects excess subagent calls after two completed calls across durable resumes.",
  async test(t) {
    await t.send("CODEMODE-LIMIT-START");
    t.succeeded();
    t.calledTool("code_mode", { count: 1 });
    t.notCalledTool("Workflow");
    t.calledSubagent("marker", { count: 2 });
    t.messageIncludes("MARKER:limit-alpha");
    t.messageIncludes("MARKER:limit-beta");
    t.messageIncludes("CODE_MODE_SUBAGENT_LIMIT_REACHED");
  },
});
