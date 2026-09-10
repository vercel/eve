import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const SESSION_COUNT = 20;
const METRIC_PREFIX = "EVE_STABLE_IMAGE_CACHE=";

export default defineEval({
  description:
    "Sandbox startup experiment: no bootstrap or managed files skips the eve template snapshot.",
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

    const sessions = Array.from({ length: SESSION_COUNT }, () => t.newSession());
    const batchStartedAt = performance.now();
    const batchStartedAtMs = Date.now();
    const samples = await Promise.all(
      sessions.map(async (session, index) => {
        const startedAt = performance.now();
        const startedAtMs = Date.now();
        const result = await session.send(`stable-image-${index}`);
        result.expectOk();
        await t.require(result.message, equals("done"));
        return {
          durationMs: performance.now() - startedAt,
          endedAtMs: Date.now(),
          sessionId: result.sessionId,
          sessionNumber: index + 1,
          startedAtMs,
        };
      }),
    );

    t.log(
      `${METRIC_PREFIX}${JSON.stringify({
        batchDurationMs: performance.now() - batchStartedAt,
        batchEndedAtMs: Date.now(),
        batchStartedAtMs,
        fixture: "stable-eve-image-cache",
        samples,
        schemaVersion: 1,
        sessionCount: SESSION_COUNT,
        variant: "pinned-eve-image-digest",
      })}`,
    );
    t.succeeded();
  },
});
