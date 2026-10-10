import { defineEval } from "eve/evals";

const MARKER = "authored-always-unrelated-input-P7M2";
const TOOL_NAME = "gate";

/**
 * Regression reproduction for https://github.com/vercel/eve/issues/533: an
 * unrelated message must never replay the unresolved authored tool call. The
 * approval holds the turn, so the message steers it and cancels the approval;
 * the call is resolved as ignored and never runs.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "HITL repro (#533): unrelated input cancels, and never replays, an unresolved authored tool call.",
  async test(t) {
    const held = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    const session = held.session;
    held.calledTool(TOOL_NAME, { status: "pending", count: 1 });
    const approval = session.requireInputRequest({
      display: "confirmation",
      toolName: TOOL_NAME,
    });

    const unrelated = await session.send(
      "Note this unrelated marker and do not call any tools: ORBITAL-PINE-6C3R.",
    );

    unrelated.expectOk();
    unrelated.event("interaction.settled", {
      count: 1,
      data: { interactionId: approval.requestId, outcome: "withdrawn" },
    });
    unrelated.calledTool(TOOL_NAME, { output: new RegExp(MARKER), count: 0 });
    unrelated.event("turn.settled", { count: 1, data: { outcome: "completed" } });
    t.succeeded();
  },
});
