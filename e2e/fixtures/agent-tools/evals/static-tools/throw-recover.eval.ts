import { defineEval } from "eve/evals";

// An authored tool throw surfaces as action.result with isError: true
// (no turn.failed), and the session stays responsive for a follow-up.
export default defineEval({
  description: "Static tools smoke: tool throw surfaces as isError and the session recovers.",
  async test(t) {
    const first = await t.send(
      'Call the `always-throws` tool exactly once with reason "smoke". ' +
        "After it fails, reply with a one-line acknowledgement that the tool failed.",
    );
    first.expectOk();
    const throwingCall = first.toolCalls.find((call) => call.name === "always-throws");
    if (throwingCall === undefined) {
      throw new Error("Turn 1: expected an always-throws call; saw none.");
    }
    if (throwingCall.isError !== true) {
      throw new Error("Turn 1: expected the always-throws result to report isError=true.");
    }

    const second = await t.send(
      "Are you still responsive? Reply with exactly the single word: yes.",
    );
    second.expectOk();
    if (second.message === undefined || !/\byes\b/iu.test(second.message)) {
      throw new Error(
        `Expected follow-up reply to contain "yes"; got: ${JSON.stringify(second.message)}`,
      );
    }

    t.didNotFail();
    t.completed();
    t.calledTool("always-throws", { isError: true, times: 1 });
    t.messageIncludes(/\byes\b/iu);
  },
});
