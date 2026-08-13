import { defineEval } from "eve/evals";

import { authorizationUrl, gateLifecycle, sendAs, verifyFollowUp } from "./shared";

export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: {
    transitions: ["owner.auth.deadline.complete-timed-out", "owner.auth.callback.reject-stale"],
  },
  timeoutMs: 30_000,
  description:
    "owner.auth.deadline.complete-timed-out / owner.auth.callback.reject-stale: deadline wins once and the late callback is stale.",
  async test(t) {
    gateLifecycle(t);
    const parked = await sendAs(t, "Call auth-timeout-probe exactly once.", "A");
    parked.event("authorization.required", { count: 1 });
    const required = parked.events.find((event) => event.type === "authorization.required") as
      | { readonly data: { readonly authorizationId?: unknown } }
      | undefined;
    if (typeof required?.data.authorizationId !== "string") {
      throw new Error("authorization.required did not expose authorizationId.");
    }
    const authorizationId = required.data.authorizationId;
    const callback = authorizationUrl(parked);
    const state = t.state as { readonly streamIndex?: unknown } | undefined;
    if (typeof state?.streamIndex !== "number") throw new Error("Missing timeout cursor.");

    const timeoutLive = t.target.watchTurn(parked.sessionId, { startIndex: state.streamIndex });
    const timedOut = await timeoutLive.result();
    timedOut.eventsSatisfy("deadline completes the same authorization once", (events) => {
      const matching = events.filter((event) => {
        const candidate = event as {
          readonly data?: Record<string, unknown>;
          readonly type: string;
        };
        return (
          candidate.type === "authorization.completed" &&
          candidate.data?.authorizationId === authorizationId &&
          candidate.data.outcome === "timed-out"
        );
      });
      return matching.length === 1;
    });
    timedOut.notEvent("action.result", {
      data: { result: { toolName: "auth-timeout-probe" }, status: "completed" },
    });
    timedOut.event("session.waiting", { count: 1 });

    const timeoutState = timeoutLive.session.state as
      | { readonly streamIndex?: unknown }
      | undefined;
    if (typeof timeoutState?.streamIndex !== "number") throw new Error("Missing stale cursor.");
    const response = await t.target.fetch(`${callback.pathname}${callback.search}`);
    if (!response.ok) throw new Error(`Late callback failed (${String(response.status)}).`);
    const lateLive = t.target.watchTurn(parked.sessionId, {
      startIndex: timeoutState.streamIndex,
    });
    const late = await lateLive.result();
    late.eventsSatisfy("late callback is rejected once as stale", (events) => {
      const matching = events.filter((event) => {
        const candidate = event as {
          readonly data?: Record<string, unknown>;
          readonly type: string;
        };
        return (
          candidate.type === "authorization.callback.rejected" &&
          candidate.data?.authorizationId === authorizationId &&
          candidate.data.reason === "stale"
        );
      });
      return matching.length === 1;
    });
    late.notEvent("action.result", {
      data: { result: { toolName: "auth-timeout-probe" }, status: "completed" },
    });
    late.notEvent("authorization.completed");
    await verifyFollowUp(lateLive.session, parked.sessionId, "AUTH-TIMEOUT-FOLLOW-UP-OK");
  },
});
