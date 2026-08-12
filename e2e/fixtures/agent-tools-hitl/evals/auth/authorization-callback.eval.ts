import { defineEval } from "eve/evals";

import { authorizationId, gateLifecycle, invokeCallback, sendAs, verifyFollowUp } from "./shared";

const TOKEN = "interactive-auth-token-H6P3";

export default defineEval({
  tags: ["real-model"],
  metadata: { transition: "owner.auth.callback.complete" },
  description:
    "owner.auth.callback.complete: one callback completes the matching challenge and keeps the session active.",
  async test(t) {
    gateLifecycle(t);
    const parked = await sendAs(
      t,
      'Call auth-probe exactly once with marker "callback-ok". Include its token verbatim.',
      "A",
    );
    parked.event("authorization.required", { count: 1 });
    const pendingAuthorizationId = authorizationId(parked);
    parked.notEvent("authorization.completed");
    parked.event("session.waiting", { count: 1 });

    const resumed = await invokeCallback(t, parked);
    resumed.turn.expectOk();
    resumed.turn.eventOrder([
      { type: "authorization.completed", count: 1 },
      {
        type: "action.result",
        data: { result: { toolName: "auth-probe" }, status: "completed" },
        count: 1,
      },
    ]);
    resumed.turn.eventsSatisfy("completion identifies the challenge that opened", (events) => {
      const matches = events.filter((event) => {
        if (event.type !== "authorization.completed") return false;
        const data = event.data as Record<string, unknown>;
        return data.authorizationId === pendingAuthorizationId && data.outcome === "authorized";
      });
      return matches.length === 1;
    });
    resumed.turn.calledTool("auth-probe", {
      output: { actor: "e2e-hitl-a", marker: "callback-ok", token: TOKEN },
      count: 1,
    });
    resumed.turn.messageIncludes(TOKEN);

    await verifyFollowUp(resumed.session, parked.sessionId, "AUTH-CALLBACK-FOLLOW-UP-OK");
  },
});
