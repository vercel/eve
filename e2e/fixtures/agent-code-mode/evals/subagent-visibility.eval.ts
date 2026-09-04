import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "The built-in agent child receives neither code_mode nor the removed Workflow wrapper.",
  async test(t) {
    await t.send("CODEMODE-VISIBILITY-START");
    t.succeeded();
    t.calledTool("code_mode", { count: 1 });
    t.calledSubagent("agent", { count: 1 });
    t.messageIncludes("CHILD_WRAPPER_ABSENT");
  },
});
