import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const SESSION_COUNT = 20;
const METRIC_PREFIX = "EVE_SANDBOX_TEMPLATE_AB=";

export default defineEval({
  description: "Sandbox startup control: an empty bootstrap forces an eve template snapshot.",
  tags: ["sandbox", "performance"],
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
        const result = await session.send(`template-control-${index}`);
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
        fixture: "sandbox-template-control",
        samples,
        schemaVersion: 1,
        sessionCount: SESSION_COUNT,
        variant: "template-empty-bootstrap",
      })}`,
    );
    t.succeeded();
  },
});
