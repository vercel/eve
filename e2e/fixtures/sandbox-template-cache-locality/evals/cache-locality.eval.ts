import { defineEval, type EveEvalContext, type EveEvalSession } from "eve/evals";
import { equals } from "eve/evals/expect";

const CONCURRENT_SESSION_COUNT = 20;
const SEQUENTIAL_SESSION_COUNT = 12;
const METRIC_PREFIX = "EVE_SANDBOX_CACHE_LOCALITY=";

interface Sample {
  readonly durationMs: number;
  readonly endedAtMs: number;
  readonly sessionId: string | undefined;
  readonly sessionNumber: number;
  readonly startedAtMs: number;
}

export default defineEval({
  description:
    "Sandbox snapshot cache locality: compare concurrent cold fan-out with later sequential sessions.",
  tags: ["sandbox", "performance"],
  timeoutMs: 5 * 60_000,
  async test(t) {
    if (
      t.target.kind !== "remote" ||
      process.env.EVE_E2E_MODEL !== "mock" ||
      process.env.EVE_E2E_WORKFLOW_WORLD !== undefined
    ) {
      t.skip("Temporary performance experiment runs only in the Vercel mock-world suite.");
    }

    const concurrentSessions = Array.from({ length: CONCURRENT_SESSION_COUNT }, () =>
      t.newSession(),
    );
    const concurrentStartedAt = performance.now();
    const concurrentStartedAtMs = Date.now();
    const concurrent = await Promise.all(
      concurrentSessions.map(async (session, index) => runSession(t, session, "concurrent", index)),
    );
    const concurrentDurationMs = performance.now() - concurrentStartedAt;
    const concurrentEndedAtMs = Date.now();

    const sequentialStartedAt = performance.now();
    const sequentialStartedAtMs = Date.now();
    const sequential: Sample[] = [];
    for (let index = 0; index < SEQUENTIAL_SESSION_COUNT; index += 1) {
      sequential.push(await runSession(t, t.newSession(), "sequential", index));
    }

    t.log(
      `${METRIC_PREFIX}${JSON.stringify({
        concurrent: {
          batchDurationMs: concurrentDurationMs,
          endedAtMs: concurrentEndedAtMs,
          samples: concurrent,
          sessionCount: CONCURRENT_SESSION_COUNT,
          startedAtMs: concurrentStartedAtMs,
        },
        fixture: "sandbox-template-cache-locality",
        schemaVersion: 1,
        sequential: {
          batchDurationMs: performance.now() - sequentialStartedAt,
          endedAtMs: Date.now(),
          samples: sequential,
          sessionCount: SEQUENTIAL_SESSION_COUNT,
          startedAtMs: sequentialStartedAtMs,
        },
        variant: "shared-template-snapshot",
      })}`,
    );
    t.succeeded();
  },
});

async function runSession(
  t: EveEvalContext,
  session: EveEvalSession,
  phase: "concurrent" | "sequential",
  index: number,
): Promise<Sample> {
  const startedAt = performance.now();
  const startedAtMs = Date.now();
  const result = await session.send(`${phase}-${index}`);
  result.expectOk();
  await t.require(result.message, equals("done"));
  return {
    durationMs: performance.now() - startedAt,
    endedAtMs: Date.now(),
    sessionId: result.sessionId,
    sessionNumber: index + 1,
    startedAtMs,
  };
}
