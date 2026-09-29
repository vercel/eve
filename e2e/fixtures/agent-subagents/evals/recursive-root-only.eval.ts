import { defineEval } from "eve/evals";

const CHILD_TOKEN = "RECURSIVE_AGENT_NOT_AVAILABLE";

/** Runtime copies do not receive the root-only built-in `agent` tool. */
export default defineEval({
  tags: ["real-model"],
  description: "The built-in recursive agent tool is exposed only to the root session.",
  async test(t) {
    const completed = await t.send(
      [
        "Use the built-in agent subagent exactly once.",
        "Give the child this task:",
        "If a built-in tool named `agent` is visible, call it once and return RECURSIVE_AGENT_WAS_VISIBLE.",
        `If no built-in tool named \`agent\` is visible, return exactly ${CHILD_TOKEN}.`,
        `After the child returns, reply with its exact output and no other token.`,
      ].join(" "),
    );
    completed.expectOk();
    completed.messageIncludes(CHILD_TOKEN);

    t.succeeded();
    t.calledSubagent("agent", { status: "completed", count: 1 });
    t.noFailedActions();
  },
});
