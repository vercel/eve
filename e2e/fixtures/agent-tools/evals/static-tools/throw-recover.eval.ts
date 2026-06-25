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
    first.calledTool("always-throws", { isError: true, status: "failed", times: 1 });

    const second = await t.send(
      "Are you still responsive? Reply with exactly the single word: yes.",
    );
    second.messageIncludes(/\byes\b/iu);

    t.completed();
    t.calledTool("always-throws", { isError: true, status: "failed", times: 1 });
    t.messageIncludes(/\byes\b/iu);
  },
});
