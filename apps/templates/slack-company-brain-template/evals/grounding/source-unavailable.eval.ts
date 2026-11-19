import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description: "A failed source still ends in an answer that reports the failure.",
  async test(t) {
    const session = await t.session({
      stubs: [
        {
          id: "search",
          tool: "search_slack",
          outcome: { throw: { message: "Slack search failed: service_unavailable" } },
        },
      ],
    });
    const turn = await session.send(
      "Search Slack: what did the team decide about the Atlas launch date?",
    );
    turn.succeeded();
    turn.calledTool("search_slack", { status: "failed" });
    t.check(
      turn.reply ?? "",
      satisfies((reply: string) => reply.trim().length > 0, "the turn delivers an answer"),
    );
    t.judge(
      "The response says Slack search failed or was unavailable, does not claim that nothing " +
        "was found, and does not state a launch date.",
      { on: turn.reply },
    ).gate(0.7);
  },
});
