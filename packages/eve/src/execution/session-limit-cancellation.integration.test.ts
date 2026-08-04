import { describe, expect, it } from "vitest";
import { resumeHook, start } from "#internal/workflow/runtime.js";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  captureTurnEvents,
  containsEventSequence,
  filterEventsByType,
} from "#internal/testing/events.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

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

function expectNoFailureEvents(events: readonly UnstampedMessageStreamEvent[]): void {
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

function requestIdFromPromptTurn(events: readonly UnstampedMessageStreamEvent[]): string {
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

  it("fails a zero-quota delegation fast and declines the root's own prompt", async () => {
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
        // The root's first model call spends the whole budget, so the
        // delegated child inherits a zero remainder and fails fast --
        // approving a zero-token window could never grant tokens, so no
        // child prompt is raised (`violation.limit > 0` in
        // `enforceSessionTokenLimit`). The root receives the child's error
        // result, reaches its own pre-model gate, and parks on its OWN
        // continuation prompt.
        const hitlTurn = await stream.nextTurn();
        expect(hitlTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(hitlTurn, "subagent.called")).toHaveLength(1);
        expect(filterEventsByType(hitlTurn, "input.requested")).toHaveLength(1);
        const requestId = requestIdFromPromptTurn(hitlTurn);
        // The prompt belongs to the root, not the delegated child.
        expect(requestId.startsWith(`${run.runId}:limit:`)).toBe(true);

        // Declining the root's own prompt is a user action the stream must
        // show: the turn settles as cancelled and the session stays
        // resumable -- same contract as the direct-decline case above.
        await deliver(continuationToken, {
          kind: "deliver",
          payloads: [{ inputResponses: [{ optionId: "stop", requestId }] }],
        });
        const declinedTurn = await stream.nextTurn();
        expect(declinedTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(declinedTurn, "turn.cancelled")).toHaveLength(1);
        expect(filterEventsByType(declinedTurn, "session.completed")).toHaveLength(0);
        expect(filterEventsByType(declinedTurn, "subagent.called")).toHaveLength(0);
        expectNoFailureEvents(declinedTurn);

        // The session accepts the next message; the root is still over
        // budget, so it re-raises its own prompt (fail-closed) instead of
        // running a model call or re-dispatching the delegation.
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
        expect(filterEventsByType(followUpTurn, "turn.cancelled")).toHaveLength(0);
        expectNoFailureEvents(followUpTurn);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);
});
