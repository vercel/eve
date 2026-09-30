import { defineEval } from "eve/evals";
import { z } from "zod";

import { fixtureAuthorizationCallback } from "../agent/lib/fake-service.ts";

const searchResult = z.object({
  tools: z.array(z.object({ connection: z.string(), tool: z.string(), signature: z.string() })),
});

export default defineEval({
  description: "Connection search pauses for sign-in, then finds tools over authenticated HTTP.",
  timeoutMs: 90_000,

  async test(t) {
    const started = await t.send(
      "Alice wants to see which tools are available in private-catalog. Search that connection for its items tools, then report the available tool names.",
    );
    const session = started.session;
    started.expectOk();
    started.event("authorization.required", { count: 1 });
    started.notEvent("authorization.completed");
    started.event("session.waiting", { count: 1 });

    const required = started.events.find((event) => event.type === "authorization.required");
    if (required?.type !== "authorization.required") {
      throw new Error("Connection search did not produce an authorization challenge.");
    }
    const callback = fixtureAuthorizationCallback(t.target.url, required.data.authorization?.url);
    if (session.sessionId === undefined || session.state === undefined) {
      throw new Error("Connection search did not create a session.");
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
    completed.noFailedActions();
    completed.notEvent("authorization.required");
    completed.event("authorization.completed", {
      count: 1,
      data: { candidateId: required.data.candidateId, outcome: "authorized" },
    });
    completed.calledTool("connection_search", {
      count: 1,
      output: (value) => {
        const result = searchResult.safeParse(value);
        return (
          result.success &&
          result.data.tools.some(
            (entry) =>
              entry.connection === "private-catalog" &&
              entry.tool === "list_items" &&
              entry.signature.startsWith("list_items("),
          )
        );
      },
    });
    // Calling the tool needs the token in a later step. A real provider persists
    // it; this fixture's fake provider keeps none after sign-in.
    completed.messageIncludes("list_items");
  },
});
