import { defineEval } from "eve/evals";

const DONE_TOKEN = "RECURSIVE_SUBAGENT_DEPTH_LIMIT_OK";

/**
 * Recursive subagent stress: the prompt asks each built-in `agent` child to
 * delegate again until the configured depth cap removes subagent tools.
 */
export default defineEval({
  description:
    "Recursive subagent stress: repeated built-in agent delegation stops at the depth cap without failed actions.",
  async test(t) {
    await t.send(
      [
        "Stress recursive subagent delegation.",
        "Use the built-in agent subagent as deeply as eve allows.",
        "Root level: call agent once.",
        "The first child must call agent once.",
        "The second child must call agent once.",
        "The third child must call agent once.",
        "The fourth child must not call another subagent; it should report that no deeper delegation tool is available and return the token LEVEL_4_REACHED.",
        `After the recursive chain returns, reply with ${DONE_TOKEN} and no extra status token.`,
      ].join(" "),
    );

    t.calledSubagent("agent");
    t.noFailedActions();
    t.messageIncludes(DONE_TOKEN);
  },
});
