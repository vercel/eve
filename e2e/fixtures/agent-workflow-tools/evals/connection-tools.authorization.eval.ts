import { defineEval } from "eve/evals";
import { z } from "zod";

import { fixtureAuthorizationCallback } from "../agent/lib/fake-service.ts";

const unavailableResult = z.object({
  tools: z.array(z.unknown()).length(0),
  unavailable: z.array(
    z.object({ connection: z.string(), error: z.string(), requiresSignIn: z.literal(true) }),
  ),
});
const toolsResult = z.object({ tools: z.array(z.object({ tool: z.string() })) });
const executeResult = z.object({ items: z.array(z.string()) });

export default defineEval({
  description:
    "A plain connection search reports that private-catalog requires sign-in without prompting; searching it with signIn prompts, then lists and runs its tools over authenticated HTTP.",
  timeoutMs: 90_000,

  async test(t) {
    const started = await t.send(
      "Alice wants to see the items in private-catalog. Search that connection for its items tools, then list the items and report them.",
    );
    const session = started.session;
    started.expectOk();
    started.calledTool("connection_search", {
      count: 1,
      input: { connection: "private-catalog" },
      output: (value) =>
        unavailableResult
          .safeParse(value)
          .data?.unavailable.some((entry) => entry.connection === "private-catalog") === true,
    });
    started.event("authorization.required", { count: 1 });
    started.notEvent("authorization.completed");
    // The sign-in holds the turn; the callback resumes it.
    started.event("turn.waiting", { count: 1 });
    started.notEvent("session.waiting");

    const required = started.events.find((event) => event.type === "authorization.required");
    if (required?.type !== "authorization.required") {
      throw new Error("Connection search with signIn did not produce an authorization challenge.");
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
    completed.notEvent("turn.started");
    completed.noFailedActions();
    completed.notEvent("authorization.required");
    completed.event("authorization.completed", {
      count: 1,
      data: { candidateId: required.data.candidateId, outcome: "authorized" },
    });
    completed.calledTool("connection_search", {
      count: 1,
      input: { connection: "private-catalog", signIn: true },
      output: (value) =>
        toolsResult.safeParse(value).data?.tools.some((entry) => entry.tool === "list_items") ===
        true,
    });
    completed.calledTool("connection_execute", {
      count: 1,
      output: (value) =>
        executeResult.safeParse(value).data?.items.includes("Alice's lamp") === true,
    });
    completed.messageIncludes("Alice's lamp");
  },
});
