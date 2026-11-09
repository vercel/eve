import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description: "auto() preserves model selection when a question resumes the current turn.",
  timeoutMs: 120_000,
  async test(t) {
    const parked = await t.send("Run the auto-resume-question flow for this routine request.");
    parked.expectOk();
    parked.calledTool("ask_question", { count: 1, status: "pending" });
    const question = parked.session.requireInteraction({
      prompt: (prompt) => /Which environment/iu.test(prompt),
      toolName: "ask_question",
    });
    const staging = question.request.options?.find((option) => option.label === "Staging");
    if (staging === undefined) throw new Error("ask_question did not offer Staging.");
    const turnId = parked.events.flatMap((event) =>
      event.type === "turn.paused" &&
      event.data.awaiting.some((entry) => entry.interactionId === question.interactionId)
        ? [event.data.turnId]
        : [],
    )[0];
    if (turnId === undefined) throw new Error("The asking turn did not pause for Staging.");

    const resumed = await parked.session.respond([
      { optionId: staging.id, interactionId: question.interactionId },
    ]);

    resumed.expectOk();
    const session = resumed.session;
    // The answer delivery may settle before its asking turn; retain the receipt's cursor.
    if (
      !session.events.some((event) => event.type === "turn.settled" && event.data.turnId === turnId)
    ) {
      await session.nextTurn({ startIndex: (session.events.at(-1)?.meta.position.line ?? -1) + 1 });
    }

    session.event("turn.settled", { count: 1, data: { turnId, outcome: "completed" } });
    session.calledTool("ask_question", {
      count: 1,
      output: { answer: "Staging", status: "answered" },
      status: "completed",
    });
    session.messageIncludes("Question answered");
    t.check(session.pendingInteractions.length, equals(0)).label(
      "no pending question after resume",
    );
    session.notEvent("model.settled", { data: { outcome: "failed" } });
    session.notEvent("turn.settled", { data: { outcome: "failed" } });
    t.noFailedCalls();
  },
});
