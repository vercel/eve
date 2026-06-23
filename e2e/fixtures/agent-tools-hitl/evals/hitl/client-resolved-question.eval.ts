import { defineEval } from "eve/evals";

/**
 * Regression for #203 — the one that matters.
 *
 * An AUTHORED, widened `ask_question` (`defineClientTool` with a typed `ui`
 * payload) must: park the turn on call, resume from a structured answer, and let
 * the turn continue into a downstream executable tool — producing exactly ONE
 * `tool_result` for the parked `tool_use` id.
 *
 * The single-result invariant is asserted operationally: before the fix the
 * authored override carried an `execute`, so the resumed turn reconstructed two
 * `tool_result` blocks for one id and the provider rejected it with a 400. So a
 * green resume (`expectOk`) that continues into `note` and `completed()` can only
 * happen if the reconstructed history held a single result for the call.
 */
export default defineEval({
  description:
    "Client-resolved ask_question override parks, resumes from a structured answer, and continues to a downstream tool — one result, no duplicate-result failure on resume.",
  async test(t) {
    await t.send(
      [
        "Use the `ask_question` tool exactly once to ask me to pick a template.",
        "Set prompt to: 'Pick a template.' and set ui to { kind: 'template' }.",
        "After I answer, call the `note` tool exactly once with text set to my answer.",
        "Do not answer the question yourself, wait for my response.",
      ].join("\n"),
    );

    const [request] = t.expectInputRequests({ toolName: "ask_question" });
    if (request === undefined) {
      throw new Error("Expected a pending ask_question input request.");
    }

    // Resume with a structured (JSON) answer, the way a typed picker resolves.
    const resumed = await t.respond({
      requestId: request.requestId,
      text: '{"picked_ids":["tpl_blue"]}',
    });
    resumed.expectOk();

    // The resumed turn flowed into a downstream executable tool, so the
    // reconstructed provider history (with the parked call's single result) was
    // accepted by the model call.
    t.calledTool("note");
    t.didNotFail();
    t.completed();
  },
});
