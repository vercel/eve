import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { describe, expect, it } from "vitest";
import { resumeHook } from "#internal/workflow/runtime.js";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  captureTurnEvents,
  containsEventSequence,
  filterEventsByType,
} from "#internal/testing/events.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { workflowEntry } from "#execution/session/entry.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { SessionAuthContext } from "#channel/types.js";
import { defineHook } from "#public/definitions/hook.js";
import type { SessionUsageGrant } from "#harness/turn-tag-state.js";

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
}): Record<string, unknown> {
  return {
    "eve.auth": null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.stateLayout": 1,
    "eve.capabilities": { requestInput: true },
    "eve.channel": { kind: overrides.channelKind, state: {} },
    "eve.continuationToken": overrides.continuationToken,
  };
}

function expectNoFailureEvents(events: readonly UnstampedMessageStreamEvent[]): void {
  const types = events.map((event) => event.type);
  for (const failureType of FAILURE_EVENT_TYPES) {
    expect(types).not.toContain(failureType);
  }
}

/**
 * Sends a command to the session inbox, retrying through its claim window.
 * `waitForHook` cannot gate repeated commands on one token — it treats a hook
 * that ever received a payload as consumed — so the retry is the barrier here.
 */
async function deliver(
  continuationToken: string,
  payload: Record<string, unknown>,
  timeout = 15_000,
  auth: SessionAuthContext | null = null,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      await resumeHook(sessionInboxHookToken(continuationToken), {
        auth,
        kind: "send",
        payload,
      });
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
    const runtime = await createTestRuntime({
      agent: {
        limits: { sessionUsage: ({ window }) => window.inputTokens >= 1 },
        name: "limit-decline-root",
      },
    });
    const continuationToken = "http:limit-decline-root";

    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
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
        await deliver(continuationToken, { message: "keep going please" });
        const promptTurn = await stream.nextTurn();
        expect(promptTurn.at(-1)?.type).toBe("turn.waiting");
        const requestId = requestIdFromPromptTurn(promptTurn);

        // Declining settles the turn as cancelled — a user decision, not an
        // error, and not a session end.
        await deliver(continuationToken, {
          inputResponses: [{ optionId: "stop", requestId }],
        });
        const declinedTurn = await stream.nextTurn();

        expect(declinedTurn.at(-1)?.type).toBe("session.waiting");
        expect(
          containsEventSequence(declinedTurn, [
            "input.resolved",
            "turn.cancelled",
            "session.waiting",
          ]),
        ).toBe(true);
        expect(filterEventsByType(declinedTurn, "turn.cancelled")).toHaveLength(1);
        expect(filterEventsByType(declinedTurn, "session.completed")).toHaveLength(0);
        expectNoFailureEvents(declinedTurn);

        // The session stays over budget, so the next message re-raises the
        // prompt (fail-closed) instead of running a model call.
        await deliver(continuationToken, { message: "try again" });
        const repromptTurn = await stream.nextTurn();

        expect(repromptTurn.at(-1)?.type).toBe("turn.waiting");
        expect(filterEventsByType(repromptTurn, "input.requested")).toHaveLength(1);
        expect(filterEventsByType(repromptTurn, "turn.cancelled")).toHaveLength(0);
        expectNoFailureEvents(repromptTurn);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  // #4923: a turn parked on its continuation prompt is still alice's turn, so
  // bob's message waits for it to end instead of joining it.
  it("keeps another principal's message out of a turn parked on its prompt", async () => {
    const alice: SessionAuthContext = {
      attributes: {},
      authenticator: "test",
      principalId: "alice",
      principalType: "user",
    };
    const bob: SessionAuthContext = { ...alice, principalId: "bob" };
    const seen: (readonly [string, unknown])[] = [];
    const runtime = await createTestRuntime({
      agent: {
        limits: { sessionUsage: ({ window }) => window.inputTokens >= 1 },
        name: "limit-foreign-message",
      },
      modules: [
        {
          logicalPath: "hooks/observe.ts",
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                "message.received"(event, ctx) {
                  seen.push([event.type, ctx.session.auth.current?.principalId]);
                },
                "turn.cancelled"(event, ctx) {
                  seen.push([event.type, ctx.session.auth.current?.principalId]);
                },
                "turn.completed"(event, ctx) {
                  seen.push([event.type, ctx.session.auth.current?.principalId]);
                },
              },
            }),
          }),
        },
      ],
    });
    const continuationToken = "http:limit-foreign-message";

    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Hello there" },
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http", continuationToken }),
            "eve.auth": alice,
          },
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        await stream.nextTurn();
        await deliver(continuationToken, { message: "keep going please" }, undefined, alice);
        const promptTurn = await stream.nextTurn();
        expect(promptTurn.at(-1)?.type).toBe("turn.waiting");
        const requestId = requestIdFromPromptTurn(promptTurn);
        seen.length = 0;

        await deliver(continuationToken, { message: "bob here" }, undefined, bob);
        await deliver(
          continuationToken,
          { inputResponses: [{ optionId: "stop", requestId }] },
          undefined,
          alice,
        );
        const declined = await stream.nextTurn();
        expectNoFailureEvents(declined);
        const bobTurn = await stream.nextTurn();
        expectNoFailureEvents(bobTurn);
        expect(seen).toEqual([
          ["turn.cancelled", "alice"],
          ["message.received", "bob"],
        ]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);
});

// A Continue above a session pushes it a usage continuation. It carries no
// principal, so it never starts a turn or changes whose turn it is.
describe("session usage continuation pushed from above", () => {
  const alice: SessionAuthContext = {
    attributes: {},
    authenticator: "test",
    principalId: "alice",
    principalType: "user",
  };
  const bob: SessionAuthContext = { ...alice, principalId: "bob" };

  async function sendCommand(
    continuationToken: string,
    command: Record<string, unknown>,
  ): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (true) {
      try {
        await resumeHook(sessionInboxHookToken(continuationToken), command);
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  const pushContinuation = (
    continuationToken: string,
    grant: SessionUsageGrant = { askers: [], seq: 1 },
  ) => sendCommand(continuationToken, { grant, kind: "usage-continued" });

  async function withAliceSession(
    name: string,
    test: (input: {
      readonly continuationToken: string;
      readonly seen: (readonly [string, unknown])[];
      readonly stream: ReturnType<typeof captureTurnEvents>;
    }) => Promise<void>,
  ): Promise<void> {
    const seen: (readonly [string, unknown])[] = [];
    const record = (type: string, principalId: unknown) => seen.push([type, principalId]);
    const runtime = await createTestRuntime({
      agent: { limits: { sessionUsage: ({ window }) => window.inputTokens >= 1 }, name },
      modules: [
        {
          logicalPath: "hooks/observe.ts",
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                "message.received"(event, ctx) {
                  record(event.type, ctx.session.auth.current?.principalId);
                },
                "turn.started"(event, ctx) {
                  record(event.type, ctx.session.auth.current?.principalId);
                },
                "turn.completed"(event, ctx) {
                  record(event.type, ctx.session.auth.current?.principalId);
                },
              },
            }),
          }),
        },
      ],
    });
    const continuationToken = `http:${name}`;
    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Hello there" },
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http", continuationToken }),
            "eve.auth": alice,
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        await stream.nextTurn();
        seen.length = 0;
        await test({ continuationToken, seen, stream });
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }

  it("settles a parked turn's own prompt and keeps the turn its principal's", async () => {
    await withAliceSession("limit-push-parked", async ({ continuationToken, seen, stream }) => {
      await deliver(continuationToken, { message: "keep going please" }, undefined, alice);
      const promptTurn = await stream.nextTurn();
      expect(promptTurn.at(-1)?.type).toBe("turn.waiting");
      const requestId = requestIdFromPromptTurn(promptTurn);
      seen.length = 0;

      await pushContinuation(continuationToken);
      const resumed = await stream.nextTurn();

      expectNoFailureEvents(resumed);
      const resolved = filterEventsByType(resumed, "input.resolved");
      expect(resolved.map((event) => event.data.resolutions[0]?.requestId)).toEqual([requestId]);
      expect(resumed.at(-1)?.type).toBe("session.waiting");
      expect(seen).toEqual([["turn.completed", "alice"]]);
    });
  }, 60_000);

  it("starts no turn on an idle session and applies before its next model call", async () => {
    await withAliceSession("limit-push-idle", async ({ continuationToken, seen, stream }) => {
      await pushContinuation(continuationToken);
      await deliver(continuationToken, { message: "keep going please" }, undefined, alice);
      const next = await stream.nextTurn();

      expectNoFailureEvents(next);
      expect(filterEventsByType(next, "input.requested")).toHaveLength(0);
      expect(next.at(-1)?.type).toBe("session.waiting");
      expect(seen).toEqual([
        ["turn.started", "alice"],
        ["message.received", "alice"],
        ["turn.completed", "alice"],
      ]);
    });
  }, 60_000);

  it("ignores a late push for a prompt it already answered itself", async () => {
    await withAliceSession("limit-push-late", async ({ continuationToken, stream }) => {
      await deliver(continuationToken, { message: "keep going please" }, undefined, alice);
      const first = requestIdFromPromptTurn(await stream.nextTurn());
      const answer = (optionId: string, requestId: string) =>
        deliver(continuationToken, { inputResponses: [{ optionId, requestId }] }, undefined, alice);
      await answer("continue", first);
      expectNoFailureEvents(await stream.nextTurn());
      await deliver(continuationToken, { message: "and more" }, undefined, alice);
      const second = requestIdFromPromptTurn(await stream.nextTurn());
      expect(second).not.toBe(first);

      // The session minted grant 1 for its own Continue, so a copy of it is stale.
      await pushContinuation(continuationToken, { askers: [{ requestId: first }], seq: 1 });
      await answer("stop", second);
      const stopped = await stream.nextTurn();

      expect(
        filterEventsByType(stopped, "input.resolved").flatMap((event) =>
          event.data.resolutions.map((resolution) => resolution.response?.optionId),
        ),
      ).toEqual(["stop"]);
    });
  }, 60_000);

  it("takes a forwarded answer before its push, and the push changes nothing", async () => {
    await withAliceSession("limit-forward-first", async ({ continuationToken, stream }) => {
      await deliver(continuationToken, { message: "keep going please" }, undefined, alice);
      const requestId = requestIdFromPromptTurn(await stream.nextTurn());
      const grant: SessionUsageGrant = { askers: [{ requestId }], seq: 5 };

      await sendCommand(continuationToken, {
        auth: alice,
        kind: "deliver",
        payloads: [{ inputResponses: [{ optionId: "continue", requestId }] }],
        usageGrant: grant,
      });
      const resumed = await stream.nextTurn();
      expectNoFailureEvents(resumed);
      expect(filterEventsByType(resumed, "input.requested")).toHaveLength(0);
      expect(
        filterEventsByType(resumed, "input.resolved").flatMap((event) =>
          event.data.resolutions.map((resolution) => resolution.requestId),
        ),
      ).toEqual([requestId]);

      // Had the push opened another window, this turn's spend would not ask yet.
      await pushContinuation(continuationToken, grant);
      await deliver(continuationToken, { message: "and more" }, undefined, alice);
      expect(requestIdFromPromptTurn(await stream.nextTurn())).toMatch(/:limit:usage:1$/u);
    });
  }, 60_000);

  it("keeps another principal's typed continue queued while the prompt is open", async () => {
    await withAliceSession("limit-typed-continue", async ({ continuationToken, seen, stream }) => {
      await deliver(continuationToken, { message: "keep going please" }, undefined, alice);
      const promptTurn = await stream.nextTurn();
      const requestId = requestIdFromPromptTurn(promptTurn);
      seen.length = 0;

      await deliver(continuationToken, { message: "continue" }, undefined, bob);
      await deliver(
        continuationToken,
        { inputResponses: [{ optionId: "continue", requestId }] },
        undefined,
        alice,
      );
      const resumed = await stream.nextTurn();
      expectNoFailureEvents(resumed);
      expect(
        filterEventsByType(resumed, "input.resolved").flatMap((event) =>
          event.data.resolutions.map((resolution) => resolution.response),
        ),
      ).toEqual([{ optionId: "continue", requestId }]);
      const bobTurn = await stream.nextTurn();
      expectNoFailureEvents(bobTurn);
      expect(seen.slice(0, 3)).toEqual([
        ["turn.completed", "alice"],
        ["turn.started", "bob"],
        ["message.received", "bob"],
      ]);
    });
  }, 60_000);
});
