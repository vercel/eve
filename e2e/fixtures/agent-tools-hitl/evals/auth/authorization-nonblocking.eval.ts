import { defineEval } from "eve/evals";

/**
 * An open authorization challenge must not wedge the session: an ordinary
 * message runs as a normal turn while the challenge waits. Callback completion
 * and tool re-execution are covered deterministically by
 * `workflow-entry.integration.test.ts`.
 */
export default defineEval({
  description: "An ordinary message runs while an authorization challenge stays open.",
  async test(t) {
    const parked = await t.send(
      'Call the auth-probe tool exactly once with marker "nonblocking". Include its result.',
    );
    parked.event("authorization.required", { count: 1 });
    parked.notEvent("authorization.completed");
    parked.event("session.waiting", { count: 1 });

    const message = await t.send("Do not call any tools. Reply with exactly AUTH-OPEN-MESSAGE-OK.");
    message.expectOk();
    if (message.sessionId !== parked.sessionId) {
      throw new Error("Message while authorization was open changed session identity.");
    }
    message.event("message.received", { count: 1 });
    message.event("message.completed", { count: 1 });
    message.notEvent("authorization.completed");
    message.event("session.waiting", { count: 1 });
    message.messageIncludes("AUTH-OPEN-MESSAGE-OK");
    message.usedNoTools();
  },
});
