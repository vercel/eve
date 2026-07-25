import { describe, expect, it } from "vitest";
import { getWorld, resumeHook, start } from "#internal/workflow/runtime.js";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  captureTurnEvents,
  containsEventSequence,
  filterEventsByType,
} from "#internal/testing/events.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { sessionCancelHookToken } from "#execution/turn-cancellation-token.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

/**
 * Declining a session-limit continuation prompt cancels the in-flight turn
 * tree through the standard cancellation path: `turn.cancelled` →
 * `session.waiting`, zero failure events, and a session that stays
 * resumable. A delegated child's decline cancels the root turn, so the
 * delegating parent never receives an error result it could retry against a
 * fresh budget share.
 */

const FAILURE_EVENT_TYPES = ["step.failed", "turn.failed", "session.failed"] as const;

function buildSerializedContext(overrides: {
  channelKind: string;
  continuationToken: string;
  mode: string;
}): Record<string, unknown> {
  return {
    "eve.auth": null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.channel": { kind: overrides.channelKind, state: {} },
    "eve.continuationToken": overrides.continuationToken,
    "eve.mode": overrides.mode,
  };
}

function expectNoFailureEvents(events: readonly HandleMessageStreamEvent[]): void {
  const types = events.map((event) => event.type);
  for (const failureType of FAILURE_EVENT_TYPES) {
    expect(types).not.toContain(failureType);
  }
}

/**
 * Delivers a payload to the session's delivery hook, retrying through the
 * park boundary's dispose/recreate window. `waitForHook` cannot gate
 * repeated deliveries on one token — it treats a hook that ever received a
 * payload as consumed — so the retry is the barrier here.
 */
async function deliver(
  continuationToken: string,
  payload: Record<string, unknown>,
  timeout = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      await resumeHook(continuationToken, payload);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** Polls the world for a hook row by token (hooks are per-run; the token is global). */
async function waitForHookByToken(token: string, timeout = 15_000): Promise<{ runId: string }> {
  const world = await getWorld();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const hook = await world.hooks.getByToken(token);
      if (hook !== null && hook !== undefined) {
        return hook;
      }
    } catch {
      // Not registered yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for hook token "${token}".`);
}

/** Polls the world until the given run reaches `completed`. */
async function waitForRunCompletion(runId: string, timeout = 15_000): Promise<void> {
  const world = await getWorld();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const page = await world.runs.list({ pagination: { limit: 100 } });
    const row = page.data.find((entry: { runId?: string }) => entry.runId === runId);
    if (row?.status === "completed") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for run "${runId}" to complete.`);
}

function requestIdFromPromptTurn(events: readonly HandleMessageStreamEvent[]): string {
  const requested = filterEventsByType(events, "input.requested");
  expect(requested).toHaveLength(1);
  const requestId = requested[0]?.data.requests[0]?.requestId;
  if (requestId === undefined) {
    throw new Error("Expected the continuation prompt to carry a request id.");
  }
  return requestId;
}

describe("session-limit continuation decline integration", () => {
  it("cancels the turn and keeps the session resumable when the user declines", async () => {
    const runtime = createTestRuntime({
      agent: { limits: { maxInputTokensPerSession: 1 }, name: "limit-decline-root" },
    });
    const continuationToken = "http:limit-decline-root";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "Hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        // Turn 1 replies normally and spends the 1-token budget.
        const firstTurn = await stream.nextTurn();
        expect(firstTurn.at(-1)?.type).toBe("session.waiting");
        expectNoFailureEvents(firstTurn);

        // Turn 2 parks on the continuation prompt before any model call.
        await deliver(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "keep going please" }],
        });
        const promptTurn = await stream.nextTurn();
        expect(promptTurn.at(-1)?.type).toBe("session.waiting");
        const requestId = requestIdFromPromptTurn(promptTurn);

        // Declining settles the turn as cancelled — a user decision, not an
        // error, and not a session end.
        await deliver(continuationToken, {
          kind: "deliver",
          payloads: [{ inputResponses: [{ optionId: "stop", requestId }] }],
        });
        const declinedTurn = await stream.nextTurn();

        expect(declinedTurn.at(-1)?.type).toBe("session.waiting");
        expect(
          containsEventSequence(declinedTurn, [
            "turn.started",
            "turn.cancelled",
            "session.waiting",
          ]),
        ).toBe(true);
        expect(filterEventsByType(declinedTurn, "turn.cancelled")).toHaveLength(1);
        expect(filterEventsByType(declinedTurn, "session.completed")).toHaveLength(0);
        expectNoFailureEvents(declinedTurn);

        // The session stays over budget, so the next message re-raises the
        // prompt (fail-closed) instead of running a model call.
        await deliver(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "try again" }],
        });
        const repromptTurn = await stream.nextTurn();

        expect(repromptTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(repromptTurn, "input.requested")).toHaveLength(1);
        expect(filterEventsByType(repromptTurn, "turn.cancelled")).toHaveLength(0);
        expectNoFailureEvents(repromptTurn);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  it("cancels the root turn when the user declines a delegated child's prompt", async () => {
    const runtime = createTestRuntime({
      agent: { limits: { maxInputTokensPerSession: 1 }, name: "limit-decline-child" },
    });
    const continuationToken = "http:limit-decline-child";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "Delegate to a subagent: summarize the weather." },
          serializedContext: {
            ...buildSerializedContext({
              channelKind: "http",
              continuationToken,
              mode: "conversation",
            }),
            "eve.capabilities": { requestInput: true },
          },
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        // The root's first model call spends the budget, so the delegated
        // child inherits a zero remainder and parks on its continuation
        // prompt before any model call. The proxy epilogue streams this
        // turn's waiting boundary while the root keeps waiting on the child.
        const hitlTurn = await stream.nextTurn();
        expect(hitlTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(hitlTurn, "subagent.called")).toHaveLength(1);
        const requestId = requestIdFromPromptTurn(hitlTurn);

        const cancelHook = await waitForHookByToken(sessionCancelHookToken(run.runId));

        // Declining the child's prompt cancels the root turn. The waiting
        // boundary is already on the stream, so settling emits nothing new;
        // the turn run completing is the settle barrier.
        await deliver(continuationToken, {
          kind: "deliver",
          payloads: [{ inputResponses: [{ optionId: "stop", requestId }] }],
        });
        await waitForRunCompletion(cancelHook.runId);

        // The session accepts the next message; the root itself is over
        // budget, so it re-raises its own prompt. Anything from the old
        // decline path — a parent-visible subagent error, a retry
        // re-dispatch, a model reply — would surface here instead.
        await deliver(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "follow up after decline" }],
        });
        const followUpTurn = await stream.nextTurn();

        expect(followUpTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(followUpTurn, "input.requested")).toHaveLength(1);
        expect(filterEventsByType(followUpTurn, "subagent.called")).toHaveLength(0);
        expect(filterEventsByType(followUpTurn, "message.completed")).toHaveLength(0);
        expect(filterEventsByType(followUpTurn, "session.completed")).toHaveLength(0);
        expectNoFailureEvents(followUpTurn);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);
});
