import { defineEval } from "eve/evals";
import { DIRECT_AUTHORIZATION } from "../agent/lib/remote-direct-hitl-script.js";

/** Alice's fixture principal; the remote hop itself runs as the `router-app` service. */
const ALICE = "e2e-user";

export default defineEval({
  description:
    "Alice authorizes a tool called directly in her remote agent. The forwarded sign-in names Alice, not the service hop that reached the child.",
  timeoutMs: 90_000,
  async test(t) {
    const session = await t.session();
    const live = await session.start(
      `${DIRECT_AUTHORIZATION}: Alice asks her remote agent to authorize the release checklist.`,
    );
    // The child's sign-in holds the parent's turn, so the response stops there.
    const held = await live.result();
    const required = held.events.find(
      (event) => event.type === "interaction.opened" && event.data.request.kind === "sign-in",
    );
    const callbackUrl =
      required?.type === "interaction.opened"
        ? required.data.request.signIn?.callbackUrl
        : undefined;
    if (required?.type !== "interaction.opened" || callbackUrl === undefined)
      throw new Error("Direct remote authorization has no callback URL.");
    held.event("turn.paused", {
      data: { awaiting: [{ interactionId: required.data.interactionId }] },
    });
    held.event("interaction.opened", {
      data: {
        audience: { principalIds: [ALICE] },
        request: {
          kind: "sign-in",
          signIn: { name: "direct-release-authorization", userCode: "direct-release-code" },
        },
      },
    });
    const resumed = t.target.watchTurn(live.session.sessionId, {
      startIndex: live.session.state?.streamIndex,
    });
    const callback = new URL(callbackUrl);
    callback.searchParams.set("code", "direct-release-code");
    const response = await fetch(callback);
    if (!response.ok) throw new Error(`Direct authorization callback returned ${response.status}.`);
    const turn = await resumed.result();
    turn.expectOk();
    turn.notEvent("turn.started");
    turn.event("interaction.settled", {
      data: { interactionId: required.data.interactionId, outcome: "accepted" },
    });
    turn.messageIncludes("PARENT-DIRECT-COMPLETE: DIRECT-AUTHORIZATION-COMPLETE");
    // The call starts in the held segment and settles in the resumed one.
    t.eventsSatisfy("the remote call settles once, in the resumed segment", (events) => {
      const requested = events.flatMap((event) =>
        event.type === "call.requested" && event.data.capability.name === "remote-loopback"
          ? [event.data.callId]
          : [],
      );
      const settled = turn.events.filter(
        (event) =>
          event.type === "call.settled" &&
          requested.includes(event.data.callId) &&
          event.data.outcome === "completed",
      );
      return requested.length === 1 && settled.length === 1;
    });
    t.noFailedActions();
  },
});
