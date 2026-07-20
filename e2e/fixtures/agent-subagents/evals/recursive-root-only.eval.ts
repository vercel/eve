import { defineEval } from "eve/evals";

const CHILD_TOKEN = "RECURSIVE_AGENT_NOT_AVAILABLE";

/** Runtime copies do not receive the root-only built-in `agent` tool. */
export default defineEval({
  description: "The built-in recursive agent tool is exposed only to the root session.",
  async test(t) {
    await t.send(
      [
        "Use the built-in agent subagent exactly once.",
        "Give the child this task:",
        "If a built-in tool named `agent` is visible, call it once and return RECURSIVE_AGENT_WAS_VISIBLE.",
        `If no built-in tool named \`agent\` is visible, return exactly ${CHILD_TOKEN}.`,
        `After the child returns, reply with its exact output and no other token.`,
      ].join(" "),
    );

    t.succeeded();
    t.calledSubagent("agent", { count: 1 });
    t.messageIncludes(CHILD_TOKEN);
    t.noFailedActions();
  },
});
