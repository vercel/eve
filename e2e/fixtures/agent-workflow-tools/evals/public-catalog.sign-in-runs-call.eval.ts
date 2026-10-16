import { defineEval } from "eve/evals";

import { fixtureAuthorizationCallback } from "../agent/lib/fake-service.ts";

const PROTECTED_TOOL = "public-catalog__list_orders";

export default defineEval({
  description:
    "After the user signs in for a protected MCP tool, the call that was waiting runs without asking the model again: no model call between authorization.completed and the call's result, and the call is not requested twice.",
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
    started.event("authorization.required", { count: 1 });
    started.event("turn.waiting", { count: 1 });

    const required = started.events.find((event) => event.type === "authorization.required");
    if (required?.type !== "authorization.required") {
      throw new Error("The protected tool did not produce an authorization challenge.");
    }
    if (session.sessionId === undefined || session.state === undefined) {
      throw new Error("The turn did not create a session.");
    }
    const resumed = t.target.watchTurn(session.sessionId, {
      startIndex: session.state.streamIndex,
    });
    const callback = fixtureAuthorizationCallback(t.target.url, required.data.authorization?.url);
    const response = await t.target.fetch(`${callback.pathname}${callback.search}`);
    if (!response.ok) throw new Error(`Authorization callback failed (${response.status}).`);

    const completed = await resumed.result();
    completed.expectOk();
    completed.noFailedActions();
    completed.event("authorization.completed", { count: 1, data: { outcome: "authorized" } });
    completed.calledTool(PROTECTED_TOOL, { count: 1 });
    completed.eventsSatisfy(
      "no model call between authorization.completed and the tool call's action.result",
      (events) => {
        const signedIn = events.findIndex((event) => event.type === "authorization.completed");
        const result = events.findIndex((event) => event.type === "action.result");
        return (
          signedIn >= 0 &&
          result > signedIn &&
          !events.slice(signedIn, result).some((event) => event.type === "step.started")
        );
      },
    );
    completed.eventsSatisfy(
      "the call that waited for sign-in is not requested again by the model",
      (events) =>
        !events.some(
          (event) =>
            event.type === "actions.requested" &&
            event.data.actions.some((action) => JSON.stringify(action).includes(PROTECTED_TOOL)),
        ),
    );
    completed.eventsSatisfy(
      "one model call after sign-in, the one that reads the result",
      (events) => events.filter((event) => event.type === "step.started").length === 1,
    );
  },
});
