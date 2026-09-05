import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "An eve tool receives structured output from a recursive client call with fetch tracing enabled.",
  timeoutMs: 180_000,
  async test(t) {
    const turn = await t.send("Call call_child exactly once, then report its returned data.");
    turn.expectOk();
    turn.calledTool("call_child", {
      output: /"data":\{"answer":"client-recursion-ok"\}/u,
    });
    turn.calledTool("call_child", { output: /"status":"waiting"/u });
    t.noFailedActions();
  },
});
