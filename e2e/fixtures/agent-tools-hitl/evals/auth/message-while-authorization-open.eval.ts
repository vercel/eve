import { defineEval } from "eve/evals";

import { authorizationId, gateLifecycle, invokeCallback, sendAs, verifyFollowUp } from "./shared";

export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: { transition: "owner.auth.message.run-open" },
  description:
    "owner.auth.message.run-open: an ordinary message runs while the challenge stays open.",
  async test(t) {
    gateLifecycle(t);
    const parked = await sendAs(
      t,
      'Call auth-probe exactly once with marker "message-open". Include its result.',
      "A",
    );
    parked.event("authorization.required", { count: 1 });
    const pendingAuthorizationId = authorizationId(parked);

    const message = await sendAs(
      t,
      "Do not call tools. Reply with exactly AUTH-OPEN-MESSAGE-OK.",
      "B",
    );
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

    const resumed = await invokeCallback(t, parked);
    resumed.turn.eventsSatisfy("callback completes the original authorization", (events) => {
      const matching = events.filter((event) => {
        const candidate = event as {
          readonly data?: Record<string, unknown>;
          readonly type: string;
        };
        return (
          candidate.type === "authorization.completed" &&
          candidate.data?.authorizationId === pendingAuthorizationId &&
          candidate.data.outcome === "authorized"
        );
      });
      return matching.length === 1;
    });
    resumed.turn.calledTool("auth-probe", {
      output: { actor: "e2e-hitl-a", marker: "message-open" },
      count: 1,
    });
    await verifyFollowUp(resumed.session, parked.sessionId, "AUTH-OPEN-FOLLOW-UP-OK");
  },
});
