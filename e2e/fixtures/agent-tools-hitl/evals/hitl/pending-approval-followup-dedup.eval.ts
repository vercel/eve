import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const MARKER = "followup-dedup-H4K8";
const TOOL_NAME = "gate";
const FOLLOW_UP_QUESTIONS = [
  "Is the gate call still waiting for my approval?",
  "Has the requested action executed yet?",
  "What are you waiting for before continuing?",
  "Can you summarize what remains blocked?",
  "What will happen after I approve the request?",
] as const;

/**
 * Regression coverage for https://github.com/vercel/eve/issues/2217: follow-up
 * questions never create another call or approval. The approval holds the
 * turn, so the first follow-up steers it and cancels the approval.
 */
export default defineEval({
  tags: ["real-model"],
  description: "Follow-up questions about a held approval never create another one.",
  async test(t) {
    const held = await t.send(`Call the ${TOOL_NAME} tool exactly once with marker "${MARKER}".`);
    const session = held.session;
    held.calledTool(TOOL_NAME, { status: "pending", count: 1 });
    const approval = session.requireInputRequest({
      display: "confirmation",
      toolName: TOOL_NAME,
    });

    for (const [index, question] of FOLLOW_UP_QUESTIONS.entries()) {
      const followup = await session.send(question);

      followup.expectOk();
      followup.notEvent("actions.requested");
      followup.notEvent("input.requested");
      if (index === 0) {
        // The steer cancels the held call, so its not-run result lands in this turn.
        followup.calledTool(TOOL_NAME, { status: "completed", count: 0 });
        followup.event("input.resolved", {
          count: 1,
          data: {
            resolutions: (resolutions) =>
              resolutions.some(
                (resolution) =>
                  resolution.requestId === approval.requestId && resolution.outcome === "ignored",
              ),
          },
        });
      } else {
        followup.usedNoTools();
      }
      followup.event("session.waiting", { count: 1 });
    }

    t.succeeded();
    t.check(session.pendingInputRequests.length, equals(0));
    t.notEvent("action.result", {
      data: { result: { output: new RegExp(MARKER), toolName: TOOL_NAME } },
    });
  },
});
