import { defineEval } from "eve/evals";

/**
 * A freeform answer can resolve an ask_question request before the user clicks
 * one of its rendered controls. A later click must become a new user turn,
 * even if another question is pending, so the model can decide whether that
 * old selection is still relevant.
 */
export default defineEval({
  description:
    "HITL smoke: a stale ask-question selection becomes a new user turn while another question is pending.",
  async test(t) {
    await t.send(
      [
        "Use the `ask_question` tool exactly once to ask me which context to use.",
        "Set prompt to: 'Which context should I use?'",
        "Set allowFreeform to true.",
        "Provide exactly two options:",
        '- id "current", label "Use current context"',
        '- id "candidate", label "Use STALE-CANDIDATE-7Q4M"',
        "Do not answer the question yourself, wait for my response.",
      ].join("\n"),
    );

    const request = t.requireInputRequest({
      optionIds: ["current", "candidate"],
      toolName: "ask_question",
    });

    const intervening = await t.send(
      "Use current context instead and reply with exactly INTERVENING-HITL-OK.",
    );
    intervening.expectOk();
    intervening.notEvent("input.requested");
    intervening.messageIncludes(/INTERVENING-HITL-OK/i);

    const nextQuestionTurn = await t.send(
      [
        "Use the `ask_question` tool exactly once to ask which new context to use.",
        "Set prompt to: 'Which new context should I use?'",
        "Set allowFreeform to false.",
        "Provide exactly two options:",
        '- id "alpha", label "Use alpha"',
        '- id "beta", label "Use beta"',
        "Do not answer the question yourself, wait for my response.",
      ].join("\n"),
    );
    nextQuestionTurn.expectOk();
    nextQuestionTurn.event("input.requested", { count: 1 });
    const nextRequest = t.requireInputRequest({
      optionIds: ["alpha", "beta"],
      toolName: "ask_question",
    });
    if (nextRequest.requestId === request.requestId) {
      throw new Error("The second ask_question call reused the stale request ID.");
    }

    const staleSelection = await t.respond({
      requestId: request.requestId,
      optionId: "candidate",
    });
    staleSelection.expectOk();
    staleSelection.event("message.received", {
      count: 1,
      data: { message: "Use STALE-CANDIDATE-7Q4M" },
    });
    // The stale selection reaches the model as context it may act on or
    // disregard; judge that the reply engages with it instead of demanding
    // a literal echo the model can rightly decline.
    t.judge.autoevals
      .closedQA(
        "The reply treats the message as a late response to an EARLIER question — either applying that earlier selection, or explaining that the earlier question was already answered or is no longer relevant (stale). Answer yes unless the reply instead treats the message as the answer to the current pending question or ignores it entirely.",
        { on: staleSelection.message },
      )
      .atLeast(0.5);

    t.succeeded();
  },
});
