import { defineEval } from "eve/evals";

/**
 * Workflow subagent budget: the fixture configures `maxSubagents` as 2 on the
 * Workflow tool, so a three-call fan-out spawns two children and the third call
 * resolves inside the program with a `WORKFLOW_SUBAGENT_LIMIT_REACHED` error.
 */
export default defineEval({
  description:
    "Workflow calls beyond the tool's maxSubagents config resolve with WORKFLOW_SUBAGENT_LIMIT_REACHED instead of spawning children.",
  async test(t) {
    await t.send(
      [
        "This is a deliberate test of the Workflow subagent budget, so ignore the advertised call limit and attempt every call.",
        "Use the Workflow tool exactly once. In its JavaScript, fan out three echo-marker subagent calls with the messages 'limit alpha', 'limit beta', and 'limit gamma' inside one Promise.all, and return the resulting three-element array.",
        "Do not call echo-marker outside Workflow and do not retry. Then reply with the returned array verbatim as JSON.",
      ].join(" "),
    );

    t.succeeded();
    t.calledTool("Workflow", { count: 1 });
    t.calledSubagent("echo-marker", { count: 2 });
    t.messageIncludes("WORKFLOW_SUBAGENT_LIMIT_REACHED");
  },
});
