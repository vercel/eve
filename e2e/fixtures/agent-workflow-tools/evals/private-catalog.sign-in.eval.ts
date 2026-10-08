import { SEARCH_TOOL } from "@eve-e2e/config/catalog-tools";
import { defineEval } from "eve/evals";
import { z } from "zod";

import { fixtureAuthorizationCallback } from "../agent/lib/fake-service.ts";

const CATALOG = "private-catalog";
const ITEMS_TOOL = "private-catalog__list_items";

const results = z.object({
  results: z.array(z.object({ description: z.string(), tool: z.string().optional() })),
});
const items = z.object({ items: z.array(z.string()) });

/** The tools a search returned. */
const found = (value: unknown) => results.safeParse(value).data?.results ?? [];

export default defineEval({
  description:
    "A plain eve__search finds private-catalog as its sign-in entry without prompting; running it through eve__tool holds the turn for sign-in, and the resumed turn signs in, then searches the private-catalog__ namespace and calls its tool over authenticated HTTP.",
  timeoutMs: 90_000,

  async test(t) {
    // A fresh principal per run: the fixture provider remembers each user's token.
    const alice = { "x-eve-forwarded-principal-id": `catalog-alice-${crypto.randomUUID()}` };
    const started = await t.send(
      "WORKFLOW-CATALOG-SIGN-IN Alice wants to see the items in her private catalog.",
      { headers: alice },
    );
    const session = started.session;
    started.expectOk();
    started.calledTool(SEARCH_TOOL, {
      count: 1,
      input: { query: CATALOG },
      output: (value) => {
        const [first] = found(value);
        return first?.tool === CATALOG && first.description.startsWith("Sign in to use the");
      },
    });
    started.event("authorization.required", { count: 1, data: { name: CATALOG } });
    started.notEvent("authorization.completed");
    // The sign-in holds the turn; the callback resumes it.
    started.event("turn.waiting", { count: 1 });
    started.notEvent("session.waiting");

    const required = started.events.find((event) => event.type === "authorization.required");
    if (required?.type !== "authorization.required") {
      throw new Error("eve__tool did not produce an authorization challenge.");
    }
    if (session.sessionId === undefined || session.state === undefined) {
      throw new Error("The sign-in turn did not create a session.");
    }
    const resumed = t.target.watchTurn(session.sessionId, {
      startIndex: session.state.streamIndex,
    });
    const response = await fetch(
      fixtureAuthorizationCallback(t.target.url, required.data.authorization?.url),
    );
    if (!response.ok) throw new Error(`Authorization callback failed (${response.status}).`);

    const completed = await resumed.result();
    completed.expectOk();
    completed.notEvent("turn.started");
    completed.noFailedActions();
    completed.notEvent("authorization.required");
    completed.event("authorization.completed", {
      count: 1,
      data: { candidateId: required.data.candidateId, outcome: "authorized" },
    });
    completed.calledTool(CATALOG, {
      count: 1,
      output: (value) => typeof value === "string" && value.startsWith("Signed in to "),
    });
    completed.calledTool(SEARCH_TOOL, {
      count: 1,
      input: { query: `${CATALOG}__` },
      output: (value) => found(value).some((entry) => entry.tool === ITEMS_TOOL),
    });
    completed.calledTool(ITEMS_TOOL, {
      count: 1,
      output: (value) => items.safeParse(value).data?.items.includes("Alice's lamp") === true,
    });
    completed.messageIncludes("Alice's lamp");
  },
});
