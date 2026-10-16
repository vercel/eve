import { defineEval } from "eve/evals";

export default defineEval({
  description: "auto() preserves model selection when a question resumes the current turn.",
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

    const answered = await parked.session.respond([
      { optionId: staging.id, interactionId: question.interactionId },
    ]);

    answered.expectOk();
    const resumed = await parked.session.nextTurn();
    resumed.expectOk();
    resumed.calledTool("ask_question", {
      count: 1,
      output: { answer: "Staging", status: "answered" },
      status: "completed",
    });
    resumed.messageIncludes("Question answered");
    resumed.notEvent("model.settled", { data: { outcome: "failed" } });
    resumed.notEvent("turn.settled", { data: { outcome: "failed" } });
    t.noFailedCalls();
  },
});
