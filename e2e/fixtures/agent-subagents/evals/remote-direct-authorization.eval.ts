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
    const required = held.events.find((event) => event.type === "authorization.required");
    if (required?.type !== "authorization.required" || required.data.webhookUrl === undefined)
      throw new Error("Direct remote authorization has no callback URL.");
    held.event("turn.waiting", { data: { on: "input" } });
    held.event("authorization.required", {
      data: {
        name: "direct-release-authorization",
        authorization: { userCode: "direct-release-code" },
        principalId: ALICE,
      },
    });
    const resumed = t.target.watchTurn(live.session.sessionId, {
      startIndex: live.session.state?.streamIndex,
    });
    const callback = new URL(required.data.webhookUrl);
    callback.searchParams.set("code", "direct-release-code");
    const response = await fetch(callback);
    if (!response.ok) throw new Error(`Direct authorization callback returned ${response.status}.`);
    const turn = await resumed.result();
    turn.expectOk();
    turn.notEvent("turn.started");
    turn.event("authorization.completed", {
      data: { name: "direct-release-authorization", outcome: "authorized", principalId: ALICE },
    });
    turn.messageIncludes("PARENT-DIRECT-COMPLETE: DIRECT-AUTHORIZATION-COMPLETE");
    // The call starts in the held segment and settles in the resumed one.
    turn.event("task.settled", {
      count: 1,
      data: { name: "remote-loopback", status: "completed" },
    });
    t.noFailedActions();
  },
});
