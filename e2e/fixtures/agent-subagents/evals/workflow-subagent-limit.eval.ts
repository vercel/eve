import { defineEval } from "eve/evals";

/**
 * workflow subagent budget: the fixture configures `maxSubagents` as 3 on the
 * workflow tool, so four sequential calls spawn three children and the fourth
 * call resolves with a `WORKFLOW_SUBAGENT_LIMIT_REACHED` error after replay.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "Sequential workflow calls share one maxSubagents budget and resolve excess calls with WORKFLOW_SUBAGENT_LIMIT_REACHED.",
  async test(t) {
    await t.send(
      [
        "Alice received a batch with four sequential echo handoffs even though this agent accepts only three workflow subagent calls. Preserve the full batch so Alice can see how the final handoff settles.",
        "Use the workflow tool exactly once. In its JavaScript, await four echo-marker subagent calls sequentially with the messages 'limit alpha', 'limit beta', 'limit gamma', and 'limit delta', and return the resulting four-element array.",
        "Do not call echo-marker outside workflow and do not retry. Then reply with the returned array verbatim as JSON.",
      ].join(" "),
    );

    t.succeeded();
    t.calledTool("workflow", { count: 1 });
    t.calledSubagent("echo-marker", { count: 3 });
    t.messageIncludes("WORKFLOW_SUBAGENT_LIMIT_REACHED");
  },
});
