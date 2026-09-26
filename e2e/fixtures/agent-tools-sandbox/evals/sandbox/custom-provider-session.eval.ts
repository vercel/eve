import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

const TOKEN = "custom-provider-session-ok-P7M";

export default defineEval({
  description: "Sandbox: custom provider session methods survive framework lifecycle wrapping.",
  async test(t) {
    const turn = await t.send(
      "Ask the `custom-provider` subagent with message: Verify the custom provider session marker.",
    );
    turn.expectOk();

    t.succeeded();
    t.calledSubagent("custom-provider", { count: 1, status: "completed" });
    t.check(turn.message, includes(TOKEN));
  },
});
