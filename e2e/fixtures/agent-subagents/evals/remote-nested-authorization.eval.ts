import { defineEval } from "eve/evals";
import { NESTED_AUTHORIZATION } from "../agent/lib/remote-nested-script.js";

const AUTHORIZATION_CODE = "nested-release-code";
const AUTHORIZATION_NAME = "nested-release-authorization";

export default defineEval({
  description:
    "Alice completes a nested worker's authorization callback through the remote parent.",
  timeoutMs: 120_000,
  async test(t) {
    const session = await t.session();
    const live = await session.start(
      `${NESTED_AUTHORIZATION}: Alice asks the remote agent to authorize her release checklist.`,
    );
    // The nested worker's sign-in holds the parent's turn, so the response stops there.
    const held = await live.result();
    const required = held.events.find(
      (event) => event.type === "interaction.opened" && event.data.request.kind === "sign-in",
    );
    const callbackUrl =
      required?.type === "interaction.opened"
        ? required.data.request.signIn?.callbackUrl
        : undefined;
    if (required?.type !== "interaction.opened" || callbackUrl === undefined) {
      throw new Error("Nested authorization challenge has no callback URL.");
    }
    held.event("turn.paused", {
      data: { awaiting: [{ interactionId: required.data.interactionId }] },
    });
    held.event("interaction.opened", {
      data: {
        request: {
          kind: "sign-in",
          signIn: { name: AUTHORIZATION_NAME, userCode: AUTHORIZATION_CODE },
        },
      },
    });
    const resumed = t.target.watchTurn(live.session.sessionId, {
      startIndex: live.session.state?.streamIndex,
    });
    const callback = new URL(callbackUrl);
    callback.searchParams.set("code", AUTHORIZATION_CODE);
    const response = await fetch(callback);
    if (!response.ok) throw new Error(`Nested authorization callback returned ${response.status}.`);

    const turn = await resumed.result();
    turn.expectOk();
    turn.notEvent("turn.started");
    turn.event("interaction.settled", {
      data: { interactionId: required.data.interactionId, outcome: "accepted" },
    });
    if (!turn.message?.includes("PARENT-NESTED-COMPLETE: CHILD-NESTED-AUTHORIZATION-COMPLETE")) {
      throw new Error("Nested authorization result did not reach the parent.");
    }
    t.noFailedActions();
  },
});
