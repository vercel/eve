import { defineEval } from "eve/evals";

/**
 * Approval resume plus a blank assistant reply leaves durable history ending
 * on an assistant message. A whitespace follow-up starts another model call
 * without adding user content, so its wire request needs a user continuation.
 */
export default defineEval({
  description: "Assistant-final resumed history gets a wire-only user continuation.",
  async test(t) {
    const parked = await t.send('Call the gate tool once with marker "M1".');
    parked.calledTool("gate", { count: 1, status: "pending" });
    t.requireInputRequest({ toolName: "gate" });

    const resumed = await t.respondAll("approve");
    resumed.expectOk();
    resumed.event("action.result", {
      count: 1,
      data: {
        result: { kind: "tool-result", toolName: "gate" },
        status: "completed",
      },
    });

    const probe = await t.send(" ");
    probe.expectOk();
    probe.messageIncludes("RESUMED_TAIL:user-continuation-after-blank-assistant");

    const audit = await t.send("[audit durable history]");
    audit.expectOk();
    audit.messageIncludes("DURABLE_CONTINUATIONS:0");
    t.succeeded();
  },
});
