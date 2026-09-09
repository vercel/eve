import { defineEval } from "eve/evals";
import { z } from "zod";

export default defineEval({
  description:
    "An eve tool receives structured output from a recursive client call with fetch tracing enabled.",
  timeoutMs: 180_000,
  async test(t) {
    const turn = await t.send("Call call_child exactly once, then report its returned data.");
    turn.expectOk();
    const call = turn.requireToolCall("call_child");
    const { sessionId } = call.output as { sessionId: string };
    const child = await t.target.watchTurn(sessionId).result();
    child.expectOk();
    child.outputMatches(z.object({ answer: z.literal("client-recursion-ok") }));
    turn.calledTool("call_child", {
      output: /"data":\{"answer":"client-recursion-ok"\}/u,
    });
    turn.calledTool("call_child", { output: /"status":"waiting"/u });
    t.noFailedActions();
  },
});
