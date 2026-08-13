import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description: "HITL smoke: approval decisions use structured controls.",
  async test(t) {
    const parked = await t.send('Call the guarded-echo tool with note "button-only".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({ display: "confirmation", toolName: "guarded-echo" });
    const cancelled = await t.respond([{ optionId: "cancel", requestId: request.requestId }]);
    cancelled.expectOk();
    t.succeeded();
  },
});
