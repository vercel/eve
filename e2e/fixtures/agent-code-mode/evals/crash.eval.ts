import { defineEval } from "eve/evals";
import { z } from "zod";
import { counters } from "../agent/lib/counters.js";

const executeResult = z.object({
  status: z.literal("completed"),
  output: z.object({
    before: z.literal(1),
    unknown: z.string().includes("side effect may or may not have happened"),
  }),
  interpreter: z.object({
    startupMs: z.number().finite().nonnegative(),
    runMs: z.number().finite().nonnegative(),
  }),
});
const expectedCounters = z
  .object({ count: z.literal(1), crash: z.literal(1), counters: z.literal(1).optional() })
  .strict();

export default defineEval({
  description:
    "A worker crash after a side effect produces an unknown outcome without repeating any completed call.",
  timeoutMs: 120000,
  async test(t) {
    if (t.target.kind !== "local") t.skip("Requires the local dev worker crash/restart harness.");
    const done = await t.send(
      "CRASH: Use eve__execute to call count({}), then crash({}). Catch the crash error and return { before, unknown, counts: await tools.counters({}) }.",
    );
    done.expectOk();
    done.eventsSatisfy(
      "eve__execute completes with before=1, the unknown-outcome error, and finite non-negative interpreter timing",
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
      "persisted counters prove count/crash/counters each ran once across recovery",
      () => expectedCounters.safeParse(persisted).success,
    );
    t.succeeded();
  },
});
