import { defineEval } from "eve/evals";

const CHILD_TOKEN = "CHILD_WORKFLOW_TOOL_NOT_AVAILABLE";

/**
 * Runtime subagent Workflow visibility: the root delegates to the built-in
 * `agent` child, which should not receive the root-only `Workflow` wrapper.
 */
export default defineEval({
  description: "Runtime subagent sessions do not receive the root-only Workflow tool.",
  async test(t) {
    await t.send(
      [
        "Use the built-in agent subagent exactly once.",
        "Give the child this task:",
        "If a Workflow tool is visible, use Workflow exactly once to call echo-marker with message 'subagent workflow probe', then return WORKFLOW_WAS_VISIBLE.",
        `If no Workflow tool is visible, do not call echo-marker or any other subagent. Return exactly ${CHILD_TOKEN}.`,
        `After the child returns, reply with its exact output and no other token.`,
      ].join(" "),
    );

    t.succeeded();
    t.calledSubagent("agent", { count: 1 });
    t.notCalledTool("Workflow");
    t.notEvent("subagent.called", { data: { name: "echo-marker" } });
    t.messageIncludes(CHILD_TOKEN);
    t.noFailedActions();
  },
});
