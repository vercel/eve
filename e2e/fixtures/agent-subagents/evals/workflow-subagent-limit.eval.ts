import { defineEval } from "eve/evals";

/**
 * workflow subagent budget: the fixture configures `maxSubagents` as 2 on the
 * workflow tool, so three sequential calls spawn two children and the third
 * call resolves with a `WORKFLOW_SUBAGENT_LIMIT_REACHED` error after replay.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "Sequential workflow calls share one maxSubagents budget and resolve excess calls with WORKFLOW_SUBAGENT_LIMIT_REACHED.",
  async test(t) {
    await t.send(
      [
        "This is a deliberate test of the workflow subagent budget, so ignore the advertised call limit and attempt every call.",
        "Use the workflow tool exactly once. In its JavaScript, await three echo-marker subagent calls sequentially with the messages 'limit alpha', 'limit beta', and 'limit gamma', and return the resulting three-element array.",
        "Do not call echo-marker outside workflow and do not retry. Then reply with the returned array verbatim as JSON.",
      ].join(" "),
    );

    t.succeeded();
    t.calledTool("workflow", { count: 1 });
    t.calledSubagent("echo-marker", { count: 2 });
    t.messageIncludes("WORKFLOW_SUBAGENT_LIMIT_REACHED");
  },
});
