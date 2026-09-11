import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

/**
 * HITL flow: `once()` approval semantics — a denial does not grant, so the
 * follow-up guarded call re-parks. Parking is server-side, so every
 * park/resume here is deterministic.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "Structured cancellation denies a once() call without executing or granting the next call.",
  async test(t) {
    const parked = await t.send('Call the guarded-echo tool with note "denied-call".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({
      display: "confirmation",
      toolName: "guarded-echo",
    });

    const denied = await t.respond([{ optionId: "cancel", requestId: request.requestId }]);
    denied.expectOk();
    denied.succeeded().label("structured cancellation finishes before the next guarded call");
    await t.require(t.pendingInputRequests, equals([]));
    denied.event("action.result", {
      data: {
        result: {
          kind: "tool-result",
          output: {
            approval: { requestId: request.requestId, status: "denied" },
            code: "TOOL_EXECUTION_DENIED",
            tool: { result: "not_run" },
          },
          toolName: "guarded-echo",
        },
        status: "rejected",
      },
      count: 1,
    });
    // The denial returns to the model as context; real models paraphrase it,
    // so judge the acknowledgment instead of matching literal wording.
    t.judge.autoevals
      .closedQA(
        "The reply acknowledges that the guarded-echo tool call was denied and did not run.",
        {
          on: denied.message,
        },
      )
      .atLeast(0.5);

    await t.send('Call the guarded-echo tool once more with note "retry-call".');
    // Denial does not grant: the follow-up call must re-park.
    t.requireInputRequest({ toolName: "guarded-echo" });

    t.parked();
    t.calledTool("guarded-echo", { status: "rejected", count: 1 });
    t.calledTool("guarded-echo", { status: "pending", count: 1 });
  },
});
