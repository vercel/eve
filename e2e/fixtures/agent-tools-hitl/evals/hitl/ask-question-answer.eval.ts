import { defineEval } from "eve/evals";

/**
 * `ask_question` is a workflow tool built on `ctx.ask()`. The model receives
 * the chosen option's label, or the user's own words, rather than an option id.
 */
export default defineEval({
  description: "ask_question returns the chosen option label or the user's own words.",
  timeoutMs: 120_000,
  async test(t) {
    const { session } = await t.send(
      'Alice is planning a release. Call the ask_question tool exactly once with question "Where should Alice ship first?"',
    );
    const choice = session.requireInputRequest({
      display: "select",
      optionIds: ["1", "2"],
      prompt: "Where should Alice ship first?",
      toolName: "ask_question",
    });
    if (choice.kind !== "question" || choice.allowFreeform !== true) {
      throw new Error("ask_question must ask a question that accepts free text.");
    }

    const chosen = await session.respond([{ optionId: "2", requestId: choice.requestId }]);
    chosen.expectOk();
    chosen.calledTool("ask_question", { count: 1, status: "completed" });
    chosen.messageIncludes('"answer":"Production"');

    const second = await session.send(
      'Bob wants a second opinion. Call the ask_question tool exactly once with question "Where should Bob ship first?"',
    );
    const typed = second.session.requireInputRequest({
      prompt: "Where should Bob ship first?",
      toolName: "ask_question",
    });
    const answered = await session.respond([
      { requestId: typed.requestId, text: "Canary pool in us-east" },
    ]);
    answered.expectOk();
    answered.messageIncludes('"answer":"Canary pool in us-east"');

    t.noFailedActions();
  },
});
