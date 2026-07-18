import { defineEval } from "eve/evals";

/**
 * The plain stale path: a follow-up message resolves the ask_question
 * request and the turn completes with nothing pending. A later click on the
 * old control must start a new user turn instead of erroring or reviving
 * the request.
 */
export default defineEval({
  description:
    "HITL smoke: a stale ask-question selection becomes a new user turn when nothing is pending.",
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

    const staleSelection = await t.respond({
      requestId: request.requestId,
      optionId: "candidate",
    });
    staleSelection.expectOk();
    staleSelection.notEvent("input.requested");
    staleSelection.event("message.received", {
      count: 1,
      data: { message: "Use STALE-CANDIDATE-7Q4M" },
    });
    // The stale selection reaches the model as context it may act on or
    // disregard; judge that the reply engages with it instead of demanding
    // a literal echo the model can rightly decline.
    t.judge.autoevals
      .closedQA(
        "The reply treats the message as a late response to an EARLIER question — either applying that earlier selection, or explaining that the earlier question was already answered or is no longer relevant (stale). Answer yes unless the reply ignores the message entirely or is unrelated to it.",
        { on: staleSelection.message },
      )
      .atLeast(0.5);

    t.succeeded();
  },
});
