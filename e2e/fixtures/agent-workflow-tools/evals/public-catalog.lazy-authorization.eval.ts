import { defineEval } from "eve/evals";

import { fixtureAuthorizationCallback } from "../agent/lib/fake-service.ts";

const mentions = (text: string) => (value: unknown) => JSON.stringify(value).includes(text);

export default defineEval({
  description:
    "An MCP server that lists its tools without a token connects and runs its public tool with no sign-in; its protected tool asks the user to sign in, then resumes over authenticated HTTP.",
  timeoutMs: 90_000,

  async test(t) {
    if (process.env.EVE_E2E_MODEL !== "mock") {
      t.skip("Requires the deterministic mock model to issue the exact calls.");
    }

    // A fresh principal per run: the fixture provider remembers each user's token.
    const alice = { "x-eve-forwarded-principal-id": `public-catalog-alice-${crypto.randomUUID()}` };
    const started = await t.send(
      "PUBLIC-CATALOG-E2E Alice wants her public-catalog items and orders.",
      {
        headers: alice,
      },
    );
    const session = started.session;
    started.expectOk();
    // Connecting a server that lists its tools anonymously needs no sign-in.
    started.calledTool("public-catalog", {
      count: 1,
      status: "completed",
      output: (value) =>
        value ===
        'The Public catalog tools are available. Find them with eve__search({ query: "public-catalog__" }).',
    });
    started.eventsSatisfy("no sign-in is requested before the protected call", (events) => {
      const protectedCall = events.findIndex(
        (event) =>
          event.type === "actions.requested" &&
          event.data.actions.some(
            (action) =>
              action.kind === "tool-call" && action.toolName === "public-catalog__list_orders",
          ),
      );
      const signIn = events.findIndex((event) => event.type === "authorization.required");
      return protectedCall >= 0 && signIn > protectedCall;
    });
    // The public tool runs before anyone signs in.
    started.calledTool("public-catalog__list_items", {
      count: 1,
      status: "completed",
      output: mentions("Lamp"),
    });
    // Only the protected tool asks for sign-in, and the turn holds on it.
    started.event("authorization.required", { count: 1 });
    started.notEvent("authorization.completed");
    started.event("turn.waiting", { count: 1 });
    started.notEvent("session.waiting");

    const required = started.events.find((event) => event.type === "authorization.required");
    if (required?.type !== "authorization.required") {
      throw new Error("The protected tool did not produce an authorization challenge.");
    }
    const callback = fixtureAuthorizationCallback(t.target.url, required.data.authorization?.url);
    if (session.sessionId === undefined || session.state === undefined) {
      throw new Error("The turn did not create a session.");
    }

    const resumed = t.target.watchTurn(session.sessionId, {
      startIndex: session.state.streamIndex,
    });
    const response = await t.target.fetch(`${callback.pathname}${callback.search}`);
    if (!response.ok) {
      throw new Error(`Authorization callback failed (${response.status}).`);
    }

    const completed = await resumed.result();
    completed.expectOk();
    completed.notEvent("turn.started");
    completed.noFailedActions();
    completed.notEvent("authorization.required");
    completed.event("authorization.completed", {
      count: 1,
      data: { candidateId: required.data.candidateId, outcome: "authorized" },
    });
    // The server answers list_orders only when the request carries the bearer.
    completed.calledTool("public-catalog__list_orders", {
      count: 1,
      output: mentions('"signedIn":true'),
    });
    completed.messageIncludes("PUBLIC_CATALOG_DONE");
    completed.messageIncludes("Alice's lamp");
  },
});
