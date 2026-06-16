import type {
  ActionResultStreamEvent,
  ActionsRequestedStreamEvent,
  HandleMessageStreamEvent,
} from "eve/client";
import { defineEval } from "eve/evals";

const MULTI_STEP_FINAL_VALUE = "phoenix-rising-9F2X";

/**
 * The i-th `actions.requested` tool call must pair with the i-th
 * `action.result` by callId. A regression that mis-pairs results with calls
 * still produces the same toolName sequence, so `toolOrder` alone cannot
 * catch it.
 */
function toolCallIdsPairInOrder(events: readonly HandleMessageStreamEvent[]): boolean {
  const requestedIds = events
    .filter((event): event is ActionsRequestedStreamEvent => event.type === "actions.requested")
    .flatMap((event) =>
      event.data.actions
        .filter((action) => action.kind === "tool-call")
        .map((action) => action.callId),
    );
  const resultIds = events
    .filter((event): event is ActionResultStreamEvent => event.type === "action.result")
    .flatMap((event) =>
      event.data.result.kind === "tool-result" ? [event.data.result.callId] : [],
    );

  return (
    requestedIds.length === 2 &&
    resultIds.length === 2 &&
    requestedIds.every((callId, index) => resultIds[index] === callId)
  );
}

// Deterministic two-step tool loop: lookup-step-a's stepKey feeds
// lookup-step-b, in order, with results paired by callId, and the
// final value flows back into the user-visible reply.
export default defineEval({
  description: "Static tools smoke: deterministic two-step tool loop with paired callIds.",
  async test(t) {
    const turn = await t.send(
      [
        "Follow these steps exactly:",
        "1. Call the `lookup-step-a` tool with topic 'demo'.",
        "2. Take the `stepKey` it returns and call the `lookup-step-b` tool with that exact stepKey.",
        "3. Reply with the final `value` from `lookup-step-b` verbatim, with no extra commentary.",
      ].join("\n"),
    );
    turn.expectOk();

    t.didNotFail();
    t.completed();
    t.toolOrder(["lookup-step-a", "lookup-step-b"]);
    t.calledTool("lookup-step-a", {
      input: { topic: "demo" },
      isError: false,
      times: 1,
    });
    t.calledTool("lookup-step-b", {
      input: { stepKey: "K-9F2X" },
      isError: false,
      times: 1,
    });
    t.noFailedActions();
    t.event(toolCallIdsPairInOrder, "tool call/result callIds pair in order");
    t.messageIncludes(MULTI_STEP_FINAL_VALUE);
  },
});
