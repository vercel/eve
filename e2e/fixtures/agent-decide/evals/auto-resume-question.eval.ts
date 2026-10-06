import { defineEval } from "eve/evals";

export default defineEval({
  description: "auto() preserves model selection when a question resumes the current turn.",
  async test(t) {
    const parked = await t.send("Run the auto-resume-question flow for this routine request.");
    parked.expectOk();
    parked.calledTool("ask_question", { count: 1, status: "pending" });
    const question = parked.session.requireInputRequest({
      prompt: (prompt) => /Which environment/iu.test(prompt),
      toolName: "ask_question",
    });
    const staging = question.options?.find((option) => option.label === "Staging");
    if (staging === undefined) throw new Error("ask_question did not offer Staging.");

    const resumed = await parked.session.respond([
      { optionId: staging.id, requestId: question.requestId },
    ]);

    resumed.expectOk();
    resumed.calledTool("ask_question", {
      count: 1,
      output: { answer: "Staging", status: "answered" },
      status: "completed",
    });
    resumed.messageIncludes("Question answered");
    resumed.notEvent("step.failed");
    resumed.notEvent("turn.failed");
    t.noFailedActions();
  },
});
