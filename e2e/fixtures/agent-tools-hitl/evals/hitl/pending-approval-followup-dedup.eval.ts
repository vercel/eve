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
 * questions never create another call or approval. Each follow-up joins the
 * held turn, and the approval stays open through all of them.
 */
export default defineEval({
  tags: ["real-model"],
  description: "Follow-up questions about a held approval never create another one.",
  async test(t) {
    const held = await t.send(`Call the ${TOOL_NAME} tool exactly once with marker "${MARKER}".`);
    const session = held.session;
    held.calledTool(TOOL_NAME, { status: "pending", count: 1 });
    const approval = session.requireInteraction({
      display: "confirmation",
      toolName: TOOL_NAME,
    });

    for (const question of FOLLOW_UP_QUESTIONS) {
      const followup = await session.send(question);

      followup.expectOk();
      followup.calledTool(TOOL_NAME, { count: 0 });
      followup.notEvent("interaction.opened");
      followup.notEvent("interaction.settled", { data: { interactionId: approval.interactionId } });
      followup.notEvent("turn.settled");
    }

    t.succeeded();
    t.check(session.pendingInteractions.length, equals(1));
    t.calledTool(TOOL_NAME, { output: new RegExp(MARKER), count: 0 });
  },
});
