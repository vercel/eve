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
      'Alice is planning a release. Call the ask_question tool exactly once with question "Where should Alice ship first?" and exactly two options labeled "Staging" and "Production". Wait for my answer before you continue.',
    );
    const choice = session.requireInteraction({
      display: "select",
      optionIds: (ids) => ids.length === 2,
      prompt: (prompt) => /Alice ship first/i.test(prompt),
      toolName: "ask_question",
    });
    if (choice.request.kind !== "question" || choice.request.allowFreeform !== true) {
      throw new Error("ask_question must ask a question that accepts free text.");
    }
    const production = choice.request.options?.find((option) => /production/i.test(option.label));
    if (production === undefined) throw new Error("ask_question did not offer Production.");

    const liveChoice = await session.startRespond([
      { optionId: production.id, interactionId: choice.interactionId },
    ]);
    let chosen;
    try {
      chosen = await liveChoice.result();
    } finally {
      t.log(JSON.stringify(liveChoice.events.slice(-16)));
    }
    chosen.expectOk();
    chosen.calledTool("ask_question", {
      count: 1,
      output: { answer: production.label, status: "answered" },
      status: "completed",
    });

    const second = await session.send(
      'Bob wants a second opinion. Call the ask_question tool exactly once with question "Where should Bob ship first?" and no options. Wait for my answer before you continue.',
    );
    const typed = second.session.requireInteraction({
      prompt: (prompt) => /Bob ship first/i.test(prompt),
      toolName: "ask_question",
    });
    const answered = await session.respond([
      { interactionId: typed.interactionId, text: "Canary pool in us-east" },
    ]);
    answered.expectOk();
    answered.calledTool("ask_question", {
      output: { answer: "Canary pool in us-east", status: "answered" },
      status: "completed",
    });

    t.noFailedCalls();
  },
});
