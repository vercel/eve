import { defineEval } from "eve/evals";

const MARKER = "authored-always-unrelated-input-P7M2";
const TOOL_NAME = "gate";

/**
 * Regression reproduction for https://github.com/vercel/eve/issues/533: an
 * unrelated message must never replay the unresolved authored tool call. The
 * message joins the held turn, the approval stays open, and the call waits for
 * it without running.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "HITL repro (#533): unrelated input never replays an unresolved authored tool call, whose approval stays open.",
  async test(t) {
    const held = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    const session = held.session;
    held.calledTool(TOOL_NAME, { status: "pending", count: 1 });
    const approval = session.requireInteraction({
      display: "confirmation",
      toolName: TOOL_NAME,
    });

    const unrelated = await session.send(
      "Note this unrelated marker and do not call any tools: ORBITAL-PINE-6C3R.",
    );

    unrelated.expectOk();
    unrelated.notEvent("interaction.settled", { data: { interactionId: approval.interactionId } });
    unrelated.notEvent("interaction.opened");
    unrelated.calledTool(TOOL_NAME, { output: new RegExp(MARKER), count: 0 });
    unrelated.notEvent("turn.settled");
    t.succeeded();
  },
});
