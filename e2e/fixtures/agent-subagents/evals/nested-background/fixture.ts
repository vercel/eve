import assert from "node:assert/strict";
import type { EveEvalContext } from "eve/evals";

export async function waitForVerification(t: EveEvalContext, workerId: string, key: string) {
  const response = await t.target.fetch(`/test/verification/${workerId}/${key}/ready`, {
    method: "POST",
    signal: t.signal,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "running" });
}

export async function releaseVerification(t: EveEvalContext, workerId: string, key: string) {
  const response = await t.target.fetch(`/test/verification/${workerId}/${key}/release`, {
    method: "POST",
    signal: t.signal,
  });
  assert.equal(response.status, 200);
  const { released, result } = await response.json();
  assert.equal(released, true);
  assert.equal(typeof result, "string");
  assert.match(result, /^VERIFIED: /);
  return result as string;
}

export async function resetSessions(t: EveEvalContext, sessionIds: readonly string[]) {
  await Promise.allSettled(
    sessionIds.map(async (sessionId) => {
      const response = await t.target.fetch(`/eve/v1/session/${sessionId}/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Nested verification eval cleanup" }),
        // Cleanup must still run when the eval's own signal has expired.
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
    }),
  );
}
