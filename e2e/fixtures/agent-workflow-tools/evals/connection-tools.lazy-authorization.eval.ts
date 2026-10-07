import { defineEval } from "eve/evals";

import { fixtureAuthorizationCallback } from "../agent/lib/fake-service.ts";

const mentions = (text: string) => (value: unknown) => JSON.stringify(value).includes(text);

export default defineEval({
  description:
    "An MCP server that lists its tools without a token runs its public tool with no sign-in; its protected tool asks the user to sign in, then resumes over authenticated HTTP.",
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
    // The public tool runs before anyone signs in.
    started.calledTool("connection_execute", {
      count: 1,
      status: "completed",
      input: { connection: "public-catalog", tool: "list_items" },
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
    const response = await fetch(callback);
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
    completed.calledTool("connection_execute", {
      count: 1,
      input: { connection: "public-catalog", tool: "list_orders" },
      output: mentions('"signedIn":true'),
    });
    completed.messageIncludes("PUBLIC_CATALOG_DONE");
    completed.messageIncludes("Alice's lamp");
  },
});
