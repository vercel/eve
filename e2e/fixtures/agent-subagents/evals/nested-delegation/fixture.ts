import assert from "node:assert/strict";
import type { EveEvalContext } from "eve/evals";
import { equals } from "eve/evals/expect";
import { z } from "zod";

/**
 * Builds the caller prompt for a two-level delegation. `handoff` names the
 * caller's delegation tool; the note is forwarded unchanged to the delegate,
 * which hands it to verification-worker.
 */
export function signOffRequest(handoff: string, key: string) {
  return `Alice is putting together her weekly project status update and needs the release checklist sign-off for it.
${handoff}
When the handoff returns, give Alice the sign-off code it returned.

Note for the handoff:
Please ask verification-worker to collect the release checklist sign-off by calling verification_gate with key ${key}.
When verification-worker returns, reply with the sign-off code it returned.`;
}

export interface NestedDelegation {
  /** Caller tool that delegates to the middle agent. */
  readonly delegate: string;
  /** Caller instruction naming how to hand off the note. */
  readonly handoff: string;
  /** Whether the middle agent must use the remote HTTP transport. */
  readonly remote?: boolean;
}

/**
 * Drives caller -> delegate -> verification-worker. Each delegation blocks its
 * caller's turn, so the gated worker's sign-off code must flow back up as tool
 * results and reach the caller's reply in the same turn it started.
 */
export async function expectNestedDelegation(t: EveEvalContext, delegation: NestedDelegation) {
  const key = crypto.randomUUID();
  const sessions: string[] = [];
  try {
    const caller = await t.session();
    sessions.push(caller.sessionId);
    const callerTurn = await caller.start(signOffRequest(delegation.handoff, key));
    const delegateCall = await callerTurn.waitForEvent("task.started");
    assert.equal(delegateCall.data.name, delegation.delegate);
    const delegateChild = delegateCall.data.child;
    assert.ok(delegateChild, "delegate must run in a child session");
    if (delegation.remote === true) {
      assert.ok(delegateChild.remote, "delegate must use the remote HTTP transport");
    }
    sessions.push(delegateChild.sessionId);

    const delegateTurn = t.target.watchTurn(delegateChild.sessionId);
    const workerCall = await delegateTurn.waitForEvent("task.started");
    assert.equal(workerCall.data.name, "verification-worker");
    const workerChild = workerCall.data.child;
    assert.ok(workerChild, "verification worker must run in a child session");
    sessions.push(workerChild.sessionId);
    const workerTurn = t.target.watchTurn(workerChild.sessionId);

    // While the worker is gated, both outer delegations are still waiting inside their turns.
    await waitForVerification(t, workerChild.sessionId, key);
    t.check(
      [...callerTurn.events, ...delegateTurn.events].some(
        (event) => event.type === "task.settled" || event.type === "turn.completed",
      ),
      equals(false),
    ).label("no delegation resolves before verification finishes");

    // The code is created on release, so no model can obtain it from the prompt.
    const code = await releaseVerification(t, workerChild.sessionId, key);
    const workerResult = (await workerTurn.result()).expectOk();
    workerResult.calledTool("verification_gate", {
      input: { key },
      output: code,
      status: "completed",
      count: 1,
    });
    workerResult.messageIncludes(code);
    const includesCode = (output: unknown) => JSON.stringify(output ?? null).includes(code);
    const delegateResult = (await delegateTurn.result()).expectOk();
    delegateResult.event("task.settled", {
      data: { output: includesCode, status: "completed", taskId: workerCall.data.taskId },
      count: 1,
    });
    delegateResult.messageIncludes(code);
    const callerResult = (await callerTurn.result()).expectOk();
    callerResult.event("task.settled", {
      data: { output: includesCode, status: "completed", taskId: delegateCall.data.taskId },
      count: 1,
    });
    callerResult.messageIncludes(code);
    t.noFailedActions();
    t.succeeded();
  } finally {
    await resetSessions(t, sessions);
  }
}

async function waitForVerification(t: EveEvalContext, workerId: string, key: string) {
  const response = await t.target.fetch(`/test/verification/${workerId}/${key}/ready`, {
    method: "POST",
    signal: t.signal,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "running" });
}

async function releaseVerification(t: EveEvalContext, workerId: string, key: string) {
  const response = await t.target.fetch(`/test/verification/${workerId}/${key}/release`, {
    method: "POST",
    signal: t.signal,
  });
  assert.equal(response.status, 200);
  const { released, result } = await response.json();
  assert.equal(released, true);
  return z.uuid().parse(result);
}

async function resetSessions(t: EveEvalContext, sessionIds: readonly string[]) {
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
