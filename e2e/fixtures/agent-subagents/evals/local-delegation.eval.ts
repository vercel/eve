import { defineEval } from "eve/evals";

const SUBAGENT_TOKEN = "SUBAGENT_TOKEN=echo-marker-9F2X";

/**
 * Local subagent delegation: the `echo-marker` child's instructions pin its
 * reply to the exact SUBAGENT_TOKEN string, so the token in the parent's final
 * message proves the child's output was spliced back into the conversation.
 */
export default defineEval({
  description: "Local subagent delegation smoke: child output reaches the parent reply verbatim.",
  async test(t) {
    await t.send(
      "Use the echo-marker subagent with message 'ping'. Once it returns, reply with the subagent's exact output included verbatim.",
    );

    t.succeeded();
    t.calledSubagent("echo-marker", { output: /SUBAGENT_TOKEN=echo-marker-9F2X/ });
    t.messageIncludes(SUBAGENT_TOKEN);
  },
});
