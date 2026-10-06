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
    cancelled.event("turn.cancelled", { count: 1 });
    cancelled.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
    cancelled.notEvent("turn.failed");

    const followup = await cancellation.session.send(`Reply with exactly ${FOLLOWUP}.`);

    followup.expectOk();
    followup.messageIncludes(FOLLOWUP);
    followup.event("step.started", { count: 1 });
    followup.event("message.completed", { count: 1 });
    followup.notEvent("turn.failed");
    t.succeeded();
  },
});
