import { defineEval } from "eve/evals";

/**
 * HITL flow: the `ask_question` tool parks the turn with a select display,
 * and responding resumes it. Parking is server-side, so every park/resume
 * here is deterministic.
 */
export default defineEval({
  description: "HITL smoke: ask-question select parks and resumes with the chosen option.",
  async test(t) {
    await t.send(
      [
        "Use the `ask_question` tool exactly once to ask me which color I prefer.",
        "Set prompt to: 'Pick a color.'",
        'Provide exactly two options: - id "red", label "Red" - id "blue", label "Blue"',
        "Do not answer the question yourself, wait for my response.",
      ].join("\n"),
    );

    t.requireInputRequest({
      display: (value) => value === undefined || value === "select",
      optionIds: ["red", "blue"],
      toolName: "ask_question",
    });

    await t.respondAll("blue");

    t.succeeded();
    t.messageIncludes(/\bblue\b/i);
  },
});
