import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import { requireStreamIndex } from "./reporting.js";

/**
 * A structured parent turn must remain pending while its background child is
 * still working, then use the child's result to satisfy the original schema.
 */
export default defineEval({
  description: "Structured output waits for an active background task.",
  tags: ["real-model"],
  async test(t) {
    const started = await t.send(
      `Find the first sample warehouse's inventory item using the built-in agent tool. Start exactly one background agent with this task: "Call probe with check=first and report its result value."

Do not guess the inventory item or produce the requested structured output until the background agent reports its result.`,
      {
        outputSchema: {
          additionalProperties: false,
          properties: { item: { type: "string" } },
          required: ["item"],
          type: "object",
        },
      },
    );

    started.expectOk();
    started.calledSubagent("agent", { count: 1 });
    started.notEvent("result.completed");
    started.event("session.waiting", { count: 1 });
    t.check(started.status, equals("waiting"));
    started.noFailedActions();

    const completed = await t.target
      .watchTurn(started.sessionId, { startIndex: requireStreamIndex(t) })
      .result();

    completed.expectOk();
    completed.event("result.completed", { count: 1 });
    completed.outputEquals({ item: "oranges" });
    completed.noFailedActions();
    t.noFailedActions();
  },
});
