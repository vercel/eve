import { defineEval } from "eve/evals";

const CHILD_TOKEN = "RECURSIVE_AGENT_NOT_AVAILABLE";
const WORKFLOW_TOKEN = "CHILD_WORKFLOW_TOOL_NOT_AVAILABLE";

/** Runtime copies receive neither the root-only recursive agent nor Workflow tool. */
export default defineEval({
  tags: ["real-model"],
  description:
    "The built-in recursive agent and Workflow tools are exposed only to the root session.",
  async test(t) {
    const started = await t.send(
      [
        "Alice is preparing a tool-availability handoff for Bob.",
        "Use the built-in agent subagent exactly once.",
        "Give the child this task: check each of the following tool names independently.",
        "If a built-in tool named `agent` is visible, call it once and record RECURSIVE_AGENT_WAS_VISIBLE.",
        `Otherwise, record ${CHILD_TOKEN} without calling it.`,
        "If a Workflow tool is visible, use it exactly once to call echo-marker with message 'child availability handoff' and record WORKFLOW_WAS_VISIBLE.",
        `Otherwise, do not call echo-marker or another subagent for this Workflow check; record ${WORKFLOW_TOKEN}.`,
        "After both checks, return the two recorded outcomes, one per line.",
        "After the child returns, reply with its exact output and no other text.",
      ].join(" "),
    );
    started.expectOk();

    const completed = await t.target
      .watchTurn(started.sessionId, { startIndex: requireStreamIndex(t) })
      .result();
    completed.expectOk();
    completed.messageIncludes(CHILD_TOKEN);
    completed.messageIncludes(WORKFLOW_TOKEN);

    t.succeeded();
    t.calledSubagent("agent", { count: 1 });
    t.notCalledTool("Workflow");
    t.notEvent("subagent.called", { data: { name: "echo-marker" } });
    t.noFailedActions();
  },
});

function requireStreamIndex(session: {
  readonly state?: { readonly streamIndex?: number };
}): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error("Parent session has no stream index.");
  return streamIndex;
}
