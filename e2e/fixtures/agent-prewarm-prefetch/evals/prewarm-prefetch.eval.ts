import { defineEval, type EveEvalContext, type EveEvalSession } from "eve/evals";
import { equals } from "eve/evals/expect";

const PREWARM_SESSION_COUNT = 5;
const MEASURED_SESSION_COUNT = 12;
const METRIC_PREFIX = "EVE_AGENT_SNAPSHOT_PREWARM=";

interface Sample {
  readonly durationMs: number;
  readonly endedAtMs: number;
  readonly sessionId: string | undefined;
  readonly sessionNumber: number;
  readonly startedAtMs: number;
}

export default defineEval({
  description:
    "Agent snapshot prewarm demo: materialize a template through throwaway sessions before measured fan-out.",
  tags: ["sandbox", "performance"],
  timeoutMs: 5 * 60_000,
  async test(t) {
    requireVercelMockWorld(t);

    const experimentStartedAtMs = Date.now();
    const prewarmStartedAt = performance.now();
    const prewarmStartedAtMs = Date.now();
    const prewarm = await runConcurrentSessions(t, PREWARM_SESSION_COUNT, "prewarm");
    const prewarmDurationMs = performance.now() - prewarmStartedAt;
    const prewarmEndedAtMs = Date.now();

    const measuredStartedAt = performance.now();
    const measuredStartedAtMs = Date.now();
    const measured = await runConcurrentSessions(t, MEASURED_SESSION_COUNT, "measured");
    const measuredEndedAtMs = Date.now();

    t.log(
      `${METRIC_PREFIX}${JSON.stringify({
        experimentDurationMs: measuredEndedAtMs - experimentStartedAtMs,
        fixture: "agent-prewarm-prefetch",
        measured: {
          batchDurationMs: performance.now() - measuredStartedAt,
          endedAtMs: measuredEndedAtMs,
          samples: measured,
          sessionCount: MEASURED_SESSION_COUNT,
          startedAtMs: measuredStartedAtMs,
        },
        prewarm: {
          batchDurationMs: prewarmEndedAtMs - prewarmStartedAtMs,
          endedAtMs: prewarmEndedAtMs,
          samples: prewarm,
          sessionCount: PREWARM_SESSION_COUNT,
          startedAtMs: prewarmStartedAtMs,
          timerDurationMs: prewarmDurationMs,
        },
        schemaVersion: 1,
        variant: "five-throwaway-agent-snapshot-prewarms",
      })}`,
    );
    t.succeeded();
  },
});

async function runConcurrentSessions(
  t: EveEvalContext,
  count: number,
  phase: string,
): Promise<Sample[]> {
  return await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const session = t.newSession();
      return await runSession(t, session, phase, index);
    }),
  );
}

async function runSession(
  t: EveEvalContext,
  session: EveEvalSession,
  phase: string,
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

function requireVercelMockWorld(t: EveEvalContext): void {
  if (
    t.target.kind !== "remote" ||
    process.env.EVE_E2E_MODEL !== "mock" ||
    process.env.EVE_E2E_WORKFLOW_WORLD !== undefined
  ) {
    t.skip("Temporary performance experiment runs only in the Vercel mock-world suite.");
  }
}
