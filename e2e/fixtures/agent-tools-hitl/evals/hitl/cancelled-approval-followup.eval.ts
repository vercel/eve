import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const TOOL_NAME = "gate";
const FOLLOWUP = "CANCELLED-APPROVAL-FOLLOW-UP-OK";

export default defineEval({
  description: "A message after cancelling an approval turn runs in the next turn's first step.",
  async test(t) {
    const held = await t.send(
      `Call the ${TOOL_NAME} tool exactly once with marker "cancelled-approval".`,
    );
    const session = held.session;
    held.calledTool(TOOL_NAME, { count: 1, status: "pending" });
    session.requireInputRequest({ display: "confirmation", toolName: TOOL_NAME });

    const cancellation = t.target.watchTurn(session.sessionId, {
      startIndex: session.state.streamIndex,
    });
    const accepted = await session.cancel();
    await t.require(
      accepted,
      satisfies(
        (value: typeof accepted) => value.status === "accepted",
        "the approval turn cancellation is accepted",
      ),
    );
    const cancelled = await cancellation.result();
    cancelled.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
    cancelled.notEvent("turn.settled", { data: { outcome: "failed" } });

    const followup = await session.send(`Reply with exactly ${FOLLOWUP}.`);

    followup.expectOk();
    followup.messageIncludes(FOLLOWUP);
    followup.event("model.started", { count: 1 });
    followup.event("content.completed", { count: 1, data: { kind: "text" } });
    followup.notEvent("turn.settled", { data: { outcome: "failed" } });
    t.succeeded();
  },
});
