import { defineEval } from "eve/evals";
import { z } from "zod";

import { fixtureAuthorizationCallback } from "../agent/lib/fake-service.ts";

const ITEMS_TOOL = "private-catalog__list_items";

const needsSignIn = z.object({
  results: z.array(z.unknown()).length(0),
  unavailable: z.array(
    z.object({
      connection: z.literal("private-catalog"),
      error: z.string(),
      requiresSignIn: z.literal(true),
    }),
  ),
});
const listsItemsTool = z.object({
  results: z.array(z.object({ tool: z.string() })),
});
const items = z.object({ items: z.array(z.string()) });

export default defineEval({
  description:
    "A plain search reports that private-catalog needs sign-in without prompting; searching it with signIn holds the turn for sign-in, and the resumed turn lists and calls its tool over authenticated HTTP.",
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
    started.calledTool("search", {
      count: 1,
      input: { connection: "private-catalog" },
      output: (value) => needsSignIn.safeParse(value).success,
    });
    started.event("authorization.required", { count: 1, data: { name: "private-catalog" } });
    started.notEvent("authorization.completed");
    // The sign-in holds the turn; the callback resumes it.
    started.event("turn.waiting", { count: 1 });
    started.notEvent("session.waiting");

    const required = started.events.find((event) => event.type === "authorization.required");
    if (required?.type !== "authorization.required") {
      throw new Error("search with signIn did not produce an authorization challenge.");
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
    completed.calledTool("search", {
      count: 1,
      input: { connection: "private-catalog", signIn: true },
      output: (value) =>
        listsItemsTool.safeParse(value).data?.results.some((entry) => entry.tool === ITEMS_TOOL) ===
        true,
    });
    completed.calledTool(ITEMS_TOOL, {
      count: 1,
      output: (value) => items.safeParse(value).data?.items.includes("Alice's lamp") === true,
    });
    completed.messageIncludes("Alice's lamp");
  },
});
