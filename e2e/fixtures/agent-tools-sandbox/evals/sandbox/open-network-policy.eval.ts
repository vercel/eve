import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Sandbox: an open-time deny-all policy applies before authored commands run.",
  async test(t) {
    const turn = await t.send(
      "Ask the `deny-all` subagent with message: " +
        "Run the bash command `curl -sS --max-time 5 -o /dev/null https://example.com || echo blocked-egress` " +
        "and reply with the command output verbatim.",
    );
    turn.expectOk();

    t.succeeded();
    t.calledSubagent("deny-all", { count: 1, status: "completed" });
    t.check(turn.message, includes("blocked-egress"));
  },
});
