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

    const [request] = t.expectInputRequests({ toolName: "ask_question" });
    if (request === undefined) {
      throw new Error("Expected a pending ask_question input request.");
    }
    if (request.display !== undefined && request.display !== "select") {
      throw new Error(`Expected select display, got ${String(request.display)}.`);
    }
    const optionIds = (request.options ?? []).map((option) => option.id);
    if (!optionIds.includes("red") || !optionIds.includes("blue")) {
      throw new Error(`Expected red/blue options, got [${optionIds.join(", ")}].`);
    }

    const resumed = await t.respondAll("blue");
    resumed.expectOk();

    t.didNotFail();
    t.completed();
    t.messageIncludes(/\bblue\b/i);
  },
});
