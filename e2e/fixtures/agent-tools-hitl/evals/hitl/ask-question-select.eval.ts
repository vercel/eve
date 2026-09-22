import { defineEval } from "eve/evals";

/**
 * HITL flow: the `ask_question` workflow tool asks with a select display, and
 * responding resumes it. The model receives the chosen option's label.
 */
export default defineEval({
  tags: ["real-model"],
  description: "HITL smoke: ask-question select waits and resumes with the chosen option.",
  async test(t) {
    const { session } = await t.send(
      [
        "Use the `ask_question` tool exactly once to ask me which color I prefer.",
        "Set the question to: 'Pick a color.'",
        'Provide exactly two options, labeled "Red" and "Blue".',
        "Do not answer the question yourself, wait for my response.",
        "After I respond, reply confirming the color I chose by name.",
      ].join("\n"),
    );

    const request = session.requireInputRequest({
      display: (value) => value === undefined || value === "select",
      optionIds: ["1", "2"],
      toolName: "ask_question",
    });
    const blue = request.options?.find((option) => /\bblue\b/i.test(option.label));
    if (blue === undefined) throw new Error("ask_question did not offer a Blue option.");

    await session.respond([{ optionId: blue.id, requestId: request.requestId }]);

    t.succeeded();
    t.messageIncludes(/\bblue\b/i);
  },
});
