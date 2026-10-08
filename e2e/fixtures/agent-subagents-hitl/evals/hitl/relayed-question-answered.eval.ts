import { defineEval } from "eve/evals";

import { waitForRelayed, waitForReply } from "./helpers";

/**
 * The question child asks Alice, through her session, where the release
 * goes. Her answer on the parent is forwarded to the child that asked, which
 * resolves its question with her choice and reports back.
 */
export default defineEval({
  description: "A child's question is relayed through the parent and answered there.",
  tags: ["hitl", "relayed"],
  timeoutMs: 90_000,
  async test(t) {
    const started = await t.send("RELAY-question-child Alice asks where the release should go.");
    const { request, session } = await waitForRelayed(t, started.session, "ask_question");
    const production = request.options?.find((option) => option.label === "Production");
    if (production === undefined) throw new Error("Expected a Production option.");

    const answered = await session.respond([
      { optionId: production.id, requestId: request.requestId },
    ]);
    answered.event("input.resolved", {
      count: 1,
      data: {
        resolutions: [
          {
            outcome: "answered",
            requestId: request.requestId,
            response: { optionId: production.id },
          },
        ],
      },
    });
    const reply = answered.message?.includes("RELAY-RESULT")
      ? answered
      : await waitForReply(t, answered.session, "RELAY-RESULT");
    reply.messageIncludes(/RELAY-RESULT QUESTION-CHILD-RESULT .*Production/u);
    t.calledSubagent("question-child", { status: "completed", count: 1 });
  },
});
