import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { checkInputHookDelivery } from "./input-hook-audit";

export default defineEval({
  description:
    "A direct approval reaches the channel and parent input hook exactly once, in order.",
  async test(t) {
    const blocked = await t.send(
      "Call collision-gate once with marker INPUT-HOOKS:DIRECT. After approval, return its result.",
    );
    blocked.calledTool("collision-gate", { count: 1, status: "pending" });
    blocked.event("input.requested", { count: 1 });
    const request = blocked.session.requireInputRequest({ toolName: "collision-gate" });
    const resumed = await blocked.session.respondAll("approve");
    resumed.expectOk();
    resumed.messageIncludes("INPUT-HOOKS:DIRECT");
    t.check(resumed.inputRequests, equals([]));
    await checkInputHookDelivery(t, resumed.session, request.requestId);
    t.calledTool("collision-gate", { count: 1, status: "completed" });
    t.noFailedActions();
    t.succeeded();
  },
});
