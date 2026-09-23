import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import type { EveEvalContext } from "eve/evals";
import { z } from "zod";

/**
 * Builds the caller prompt for a two-level delegation. `handoff` names the
 * caller's delegation tool; the note is forwarded unchanged to the delegate,
 * which hands it to verification-worker.
 */
export function signOffRequest(handoff: string, key: string) {
  return `Alice is putting together her weekly project status update and needs the release checklist sign-off for it.
${handoff}
Once the handoff is accepted, let Alice know the sign-off is in progress and end your turn.
When the handoff finishes, give Alice the sign-off code it returns.

Note for the handoff:
Please ask verification-worker to collect the release checklist sign-off by calling verification_gate with key ${key}.
Once verification-worker has started, reply that the sign-off is in progress and end your turn.
When verification-worker finishes, reply with the sign-off code it returned.`;
}

export function cancellationRequest(taskId: string) {
  return `Alice collected the checklist sign-off herself, so the handoff is no longer needed. Call task_cancel with taskIds ["${taskId}"] to stop it, then let Alice know it was cancelled.`;
}

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
  return z.uuid().parse(result);
}

export async function waitForVerificationStop(t: EveEvalContext, workerId: string, key: string) {
  const deadline = Date.now() + 45_000;
  let status: unknown;
  do {
    const response = await t.target.fetch(`/test/verification/${workerId}/${key}/status`, {
      method: "POST",
      signal: AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]),
    });
    assert.equal(response.status, 200);
    ({ status } = await response.json());
    if (status !== "running" && status !== "pending") break;
    await setTimeout(250, undefined, { signal: t.signal });
  } while (Date.now() < deadline);
  // Cooperative cancellation returns normally from the workflow wrapper. The
  // worker's turn.cancelled event distinguishes cancellation from normal success.
  assert.ok(
    status === "completed" || status === "cancelled",
    `the nested verification workflow must stop before cleanup; got ${String(status)}`,
  );
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
