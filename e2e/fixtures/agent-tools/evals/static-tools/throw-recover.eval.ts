import { defineEval } from "eve/evals";

// An authored tool throw surfaces as a failed action result (no turn.failed),
// and the session stays responsive for a follow-up.
export default defineEval({
  description: "Static tools smoke: tool throw surfaces as failed and the session recovers.",
  async test(t) {
    const first = await t.send(
      'Call the `always-throws` tool exactly once with reason "smoke". ' +
        "After it fails, reply with a one-line acknowledgement that the tool failed.",
    );
    first.expectOk();
    first.calledTool("always-throws", { status: "failed", count: 1 });

    const second = await t.send(
      "Are you still responsive? Reply with exactly the single word: yes.",
    );
    second.messageIncludes(/\byes\b/iu);

    t.succeeded();
    t.calledTool("always-throws", { status: "failed", count: 1 });
    t.messageIncludes(/\byes\b/iu);
  },
});
