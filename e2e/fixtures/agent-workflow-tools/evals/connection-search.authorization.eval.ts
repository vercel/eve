import { defineEval } from "eve/evals";
import { z } from "zod";

import { fixtureAuthorizationCallback } from "../agent/lib/fake-service.ts";

const searchResult = z.array(z.object({ qualifiedName: z.string() }));

export default defineEval({
  description:
    "Connection search pauses for sign-in, then discovers tools over authenticated HTTP.",
  timeoutMs: 90_000,

  async test(t) {
    const started = await t.send(
      "Alice wants to see which tools are available in private-catalog. Search for its items tools, then report the available tool names.",
    );
    started.expectOk();
    started.event("authorization.required", { count: 1 });
    started.notEvent("authorization.completed");
    started.event("session.waiting", { count: 1 });

    const required = started.events.find((event) => event.type === "authorization.required");
    if (required?.type !== "authorization.required") {
      throw new Error("Connection search did not produce an authorization challenge.");
    }
    const callback = fixtureAuthorizationCallback(t.target.url, required.data.authorization?.url);
    if (t.sessionId === undefined || t.state === undefined) {
      throw new Error("Connection search did not create a session.");
    }

    const resumed = t.target.watchTurn(t.sessionId, { startIndex: t.state.streamIndex });
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
          result.data.some((entry) => entry.qualifiedName === "private-catalog__list_items")
        );
      },
    });
    completed.messageIncludes("private-catalog__list_items");
  },
});
