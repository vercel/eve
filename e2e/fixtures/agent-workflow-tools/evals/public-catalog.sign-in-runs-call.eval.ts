import { defineEval } from "eve/evals";

import { fixtureAuthorizationCallback } from "../agent/lib/fake-service.ts";

const PROTECTED_TOOL = "public-catalog__list_orders";

export default defineEval({
  description:
    "After the user signs in for a protected MCP tool, the call that was waiting runs without asking the model again: its sign-in settles with the call, no model call comes between them, and the call is not requested twice.",
  timeoutMs: 90_000,

  async test(t) {
    // A fresh principal per run: the fixture provider remembers each user's token.
    const alice = { "x-eve-forwarded-principal-id": `sign-in-alice-${crypto.randomUUID()}` };
    const started = await t.send(
      "PUBLIC-CATALOG-E2E Alice wants her public-catalog items and orders.",
      { headers: alice },
    );
    const session = started.session;
    started.expectOk();
    started.event("interaction.opened", { count: 1, data: { request: { kind: "sign-in" } } });
    started.event("turn.paused", { count: 1 });

    const required = started.events.find(
      (event) => event.type === "interaction.opened" && event.data.request.kind === "sign-in",
    );
    if (required?.type !== "interaction.opened") {
      throw new Error("The protected tool did not produce an authorization challenge.");
    }
    if (session.sessionId === undefined || session.state === undefined) {
      throw new Error("The turn did not create a session.");
    }
    const resumed = t.target.watchTurn(session.sessionId, {
      startIndex: session.state.streamIndex,
    });
    const callback = fixtureAuthorizationCallback(t.target.url, required.data.request.signIn?.url);
    const response = await t.target.fetch(`${callback.pathname}${callback.search}`);
    if (!response.ok) throw new Error(`Authorization callback failed (${response.status}).`);

    const completed = await resumed.result();
    completed.expectOk();
    completed.noFailedActions();
    completed.event("interaction.settled", {
      count: 1,
      data: { interactionId: required.data.interactionId, outcome: "accepted" },
    });
    completed.calledTool(PROTECTED_TOOL, { count: 1 });
    completed.eventsSatisfy(
      "no model call between the sign-in's settlement and the waiting call's",
      (events) => {
        const signedIn = events.findIndex(
          (event) =>
            event.type === "interaction.settled" &&
            event.data.interactionId === required.data.interactionId,
        );
        const result = events.findIndex((event) => event.type === "call.settled");
        return (
          signedIn >= 0 &&
          result > signedIn &&
          !events.slice(signedIn, result).some((event) => event.type === "model.requested")
        );
      },
    );
    completed.eventsSatisfy(
      "the call that waited for sign-in is not requested again by the model",
      (events) =>
        !events.some(
          (event) =>
            event.type === "call.requested" && event.data.capability.name === PROTECTED_TOOL,
        ),
    );
    completed.eventsSatisfy(
      "one model call after sign-in, the one that reads the result",
      (events) => events.filter((event) => event.type === "model.requested").length === 1,
    );
  },
});
