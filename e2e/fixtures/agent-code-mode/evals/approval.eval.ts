import { defineEval } from "eve/evals";
import { z } from "zod";
import { counters } from "../agent/lib/counters.js";

const executeResult = z.object({
  status: z.literal("completed"),
  output: z.object({ before: z.literal(1), after: z.literal(2), approved: z.literal("approved") }),
  interpreter: z.object({
    startupMs: z.number().finite().nonnegative(),
    runMs: z.number().finite().nonnegative(),
  }),
});
const expectedCounters = z
  .object({ count: z.literal(2), gated: z.literal(1), counters: z.literal(1).optional() })
  .strict();

export default defineEval({
  description:
    "Code execution parks for a nested approval and does not repeat earlier calls when resumed.",
  async test(t) {
    if (t.target.kind !== "local")
      t.skip("Requires access to the local fixture’s persisted counters.");
    const parked = await t.send(
      "Use eve__execute to call count({}), gated({}), then count({}), sequentially. Return { before, approved, after }.",
    );
    parked.session.requireInputRequest({
      toolName: "gated",
      display: "confirmation",
      optionIds: ["approve", "cancel"],
    });
    const done = await parked.session.respondAll("approve");
    done.expectOk();
    done.eventsSatisfy(
      "eve__execute completes with the expected values and finite non-negative interpreter timing",
      (events) =>
        events.some((event) => {
          if (event.type !== "action.result") return false;
          const result = event.data.result;
          if (result === undefined || !("toolName" in result) || result.toolName !== "eve__execute")
            return false;
          const output = result.output;
          const parsed = executeResult.safeParse(output);
          if (!parsed.success)
            t.log(JSON.stringify({ executeOutput: output, issues: parsed.error.issues }));
          return event.data.status === "completed" && !result.isError && parsed.success;
        }),
    );
    const persisted = counters(done.sessionId);
    t.log(JSON.stringify({ sessionId: done.sessionId, persisted }));
    done.eventsSatisfy(
      "persisted counters prove count ran twice and gated/counters once",
      () => expectedCounters.safeParse(persisted).success,
    );
    t.succeeded();
  },
});
