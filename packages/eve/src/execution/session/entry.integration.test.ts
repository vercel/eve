import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorld, resumeHook, start } from "#internal/workflow/runtime.js";
import { hydrateWorkflowArguments } from "@workflow/core/serialization";
import { createChannelAddress } from "#channel/channel-address.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { workflowEntry } from "#execution/session/entry.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import {
  buildSessionAttributes,
  buildSubagentRootAttributes,
} from "#execution/eve-workflow-attributes.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
import { defineHook } from "#public/definitions/hook.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { isEventId } from "#protocol/event-id.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { SessionTitleKey } from "#context/keys.js";
import {
  buildSerializedContext,
  captureEvents,
  expectHookClaims,
  expectSingleTurn,
  listCallerStepNames,
  withTimeout,
} from "#internal/testing/entry-test-helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("workflowEntry integration", () => {
  it("parks before initialization and initializes with the first message identity and title", async () => {
    let initializedSessions = 0;
    let initializedAuth: unknown;
    let initializedInitiator: unknown;
    const runtime = await createTestRuntime({
      agent: { name: "workflow-entry-prewarm" },
      modules: [
        {
          logicalPath: "hooks/initialize-session.ts",
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                async "session.started"(_event, ctx) {
                  initializedSessions += 1;
                  initializedAuth = ctx.session.auth.current;
                  initializedInitiator = ctx.session.auth.initiator;
                },
              },
            }),
          }),
        },
      ],
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: {},
          serializedContext: buildSerializedContext({
            auth: { authenticator: "test", principalId: "mount", principalType: "user" },
            channelKind: "http",
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        await waitForHook(
          { runId: run.runId },
          { token: sessionInboxHookToken(sessionCommandHookToken(run.runId)) },
        );
        await expectHookClaims(run.runId, [sessionCommandHookToken(run.runId)], {
          turnStarted: false,
        });

        const sessionRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        expect(await sessionRuntime.getStreamTailIndex(run.runId)).toBe(-1);
        expect(initializedSessions).toBe(0);
        for (const kind of ["clear", "compact", "cancel"] as const) {
          await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), { kind });
        }
        const firstAuth = { authenticator: "test", principalId: "alice", principalType: "user" };
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          auth: firstAuth,
          title: "Alice’s first chat",
          kind: "send",
          payload: { message: "Say hello to Alice." },
          turnPolicy: "steer",
        });

        const firstTurn = await stream.nextTurn();
        expect(filterEventsByType(firstTurn, "session.started")).toHaveLength(1);
        expect(initializedSessions).toBe(1);
        expect(initializedAuth).toEqual(firstAuth);
        expect(initializedInitiator).toEqual(firstAuth);
        expect((await (await getWorld()).runs.get(run.runId)).attributes?.["$eve.title"]).toBe(
          "Alice’s first chat",
        );
        expectSingleTurn(firstTurn, "turn_0");
        expect(firstTurn.at(-1)?.type).toBe("session.waiting");
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          auth: { ...firstAuth, principalId: "bob" },
          title: "Do not rename",
          kind: "send",
          payload: { message: "Bob joins the conversation. Greet him briefly." },
        });
        const secondTurn = await stream.nextTurn();
        expect(filterEventsByType(secondTurn, "session.started")).toHaveLength(0);
        expectSingleTurn(secondTurn, "turn_1");
        expect(initializedSessions).toBe(1);
        expect((await (await getWorld()).runs.get(run.runId)).attributes?.["$eve.title"]).toBe(
          "Alice’s first chat",
        );
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("persists model output before settlement when a stream append exceeds the SDK flush window", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-stream-order" } });
    const world = await getWorld();
    const append = world.streams.writeMulti!.bind(world.streams);
    let delayedAppend: Promise<void> | undefined;
    const write = vi.spyOn(world.streams, "writeMulti").mockImplementation(async (...args) => {
      if (args[1].endsWith("_user") && delayedAppend === undefined) {
        delayedAppend = new Promise((resolve) => setTimeout(resolve, 1_200));
        await delayedAppend;
      }
      return await append(...args);
    });
    try {
      await runtime.run(async () => {
        const run = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: "Say hello to Alice." },
            serializedContext: buildSerializedContext({
              channelKind: "http",
              mode: "conversation",
            }),
          },
        ]);
        const stream = captureTurnEvents(run);
        try {
          const events = await stream.nextTurn();
          expect(delayedAppend).toBeDefined();
          expect(filterEventsByType(events, "message.completed")).toHaveLength(1);
          expectSingleTurn(events, "turn_0");
          expect(events.at(-1)?.type).toBe("session.waiting");
        } finally {
          await delayedAppend;
          stream.dispose();
          await run.cancel();
        }
      });
    } finally {
      write.mockRestore();
    }
  });

  it("parks in conversation mode and resumes via runtime delivery", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_inline");
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-conversation" } });
    const continuationToken = "http:workflow-entry-conversation";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            acceptedDeploymentId: "dpl_inline",
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);

      const stream = captureTurnEvents(run);
      let completed = false;
      const hook = await waitForHook(
        { runId: run.runId },
        {
          token: sessionInboxHookToken(continuationToken),
        },
      );

      try {
        const firstTurn = await stream.nextTurn();

        expect(hook.token).toBe(sessionInboxHookToken(continuationToken));
        expect(firstTurn.at(-1)).toMatchObject({
          data: { continuationToken: "workflow-entry-conversation" },
          type: "session.waiting",
        });
        expect(firstTurn.every((event) => typeof event.meta?.at === "string")).toBe(true);
        expect(
          firstTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("hello there") === true,
          ),
        ).toBe(true);

        const workflowRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        await expect(
          workflowRuntime.dispatchContinuation({
            command: {
              auth: null,
              delivery: {
                acceptedDeploymentId: "dpl_inline",
                channelKind: "http",
                channelName: "test",
                deliveryId: "delivery-followup",
              },
              kind: "send",
              payload: { message: "follow up" },
            },
            continuationToken,
          }),
        ).resolves.toEqual({
          deliveryId: "delivery-followup",
          sessionId: run.runId,
          status: "accepted",
        });

        const secondTurn = await stream.nextTurn();

        expect(secondTurn.at(-1)?.type).toBe("session.waiting");
        expect(secondTurn.every((event) => typeof event.meta?.at === "string")).toBe(true);
        expect(
          secondTurn.every((event) => event.meta?.deliveryIds?.includes("delivery-followup")),
        ).toBe(true);
        expect(
          secondTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("follow up") === true,
          ),
        ).toBe(true);

        await workflowRuntime.dispatchSession({
          command: { kind: "reset", reason: "Test step inventory" },
          sessionId: run.runId,
        });
        await expect(run.returnValue).resolves.toEqual({ output: "" });
        completed = true;
        expect(await listCallerStepNames(run.runId)).toEqual([]);
      } finally {
        stream.dispose();
        if (!completed) await run.cancel();
      }
    });
  });

  it("publishes the session ID as the waiting address for an ID-only session", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-id-only" } });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        expect((await stream.nextTurn()).at(-1)).toMatchObject({
          data: { continuationToken: run.runId },
          type: "session.waiting",
        });
        await expectHookClaims(run.runId, [sessionCommandHookToken(run.runId)]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("stamps every stream event with an id that survives a rewind", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-event-ids" } });
    const continuationToken = "http:workflow-entry-event-ids";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "identify these events" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      let firstTurn: readonly MessageStreamEvent[];
      try {
        firstTurn = await stream.nextTurn();
      } finally {
        stream.dispose();
      }

      try {
        expect(firstTurn.length).toBeGreaterThan(1);
        // No two events share an id, including appends that share
        // `(turnId, sequence, stepIndex)`.
        expect(firstTurn.every((event) => isEventId(event.meta.id))).toBe(true);
        expect(new Set(firstTurn.map((event) => event.meta.id)).size).toBe(firstTurn.length);

        // No stream-order assertion on the ids: they sort in mint order per
        // process, but a turn's events are appended by separate steps whose
        // writes can interleave behind minting (see #protocol/event-id.js),
        // so append order is not contractually sorted.
        const ids = firstTurn.map((event) => event.meta.id);

        // Re-reading the durable stream returns the same ids.
        const workflowRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        const replayed = await workflowRuntime.getEventStream(run.runId, { startIndex: 0 });
        const replayedIds: string[] = [];
        const reader = replayed.getReader();
        try {
          while (replayedIds.length < firstTurn.length) {
            const { done, value } = await reader.read();
            if (done) break;
            replayedIds.push(value.meta.id);
          }
        } finally {
          await reader.cancel();
        }

        // Order is not contractual across separate steps (see comment above):
        // compare membership and count, not append order.
        expect(replayedIds).toHaveLength(ids.length);
        expect(new Set(replayedIds)).toEqual(new Set(ids));
      } finally {
        await run.cancel();
      }
    });
  });

  it("completes an expired conversation and lets its channel start a fresh session", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-timeout" } });
    const continuationToken = "http:workflow-entry-timeout";
    const workflowRuntime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
          sessionTimeoutMs: 25,
        },
      ]);
      const stream = captureEvents(run);
      let replacementSessionId: string | undefined;

      try {
        const events = await stream.nextUntil(
          "session completion",
          (event) => event.type === "session.completed",
        );

        expect(events.some((event) => event.type === "session.waiting")).toBe(true);
        expect(events.at(-1)?.type).toBe("session.completed");
        expect(isEventId(events.at(-1)?.meta.id ?? "")).toBe(true);
        expect(filterEventsByType(events, "session.failed")).toHaveLength(0);
        await expect(run.returnValue).resolves.toEqual({ output: "" });

        const replacement = await createChannelAddress({
          adapter: { kind: "http" },
          channelName: "http",
          continuationToken: "workflow-entry-timeout",
          runtime: workflowRuntime,
        }).send("start fresh", {
          auth: null,
        });
        replacementSessionId = replacement.id;

        expect(replacement.id).not.toBe(run.runId);
        await waitForHook(
          { runId: replacement.id },
          {
            token: sessionInboxHookToken(continuationToken),
          },
        );
      } finally {
        stream.dispose();
        if (replacementSessionId !== undefined) {
          await workflowRuntime.dispatchSession({
            command: { kind: "reset", reason: "Test cleanup" },
            sessionId: replacementSessionId,
          });
        }
      }
    });
  });

  it("notifies each delegated conversation turn and remains available via agentId", async () => {
    const runtime = await createTestRuntime({
      agent: { name: "workflow-entry-delegated-conversation" },
    });
    const workflowRuntime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const childContinuationToken = "subagent:parent-session:call-1";

    await runtime.run(async () => {
      const child = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "delegated first turn" },
          serializedContext: buildSerializedContext({
            channelKind: "subagent",
            channelState: {
              callId: "call-1",
              parentContinuationToken: sessionInboxHookToken(childContinuationToken),
              parentSessionId: "parent-session",
              subagentName: "researcher",
            },
            continuationToken: childContinuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(child);

      try {
        const firstTurn = await withTimeout(stream.nextTurn(), "delegated first turn");
        expect(firstTurn.at(-1)?.type).toBe("session.waiting");
        await expect(waitForRuntimeActionResult(child.runId, "call-1")).resolves.toMatchObject({
          kind: "runtime-action-result",
          results: [
            {
              callId: "call-1",
              kind: "subagent-result",
              output: expect.stringContaining("delegated first turn"),
              subagentName: "researcher",
            },
          ],
        });

        await expect(
          workflowRuntime.dispatchSession({
            command: {
              caller: {
                callId: "call-2",
                replyTo: { kind: "hook", token: sessionInboxHookToken(childContinuationToken) },
                subagentName: "researcher",
              },
              kind: "send",
              payload: { message: "delegated follow-up turn" },
            },
            sessionId: child.runId,
          }),
        ).resolves.toEqual({
          sessionId: child.runId,
          status: "accepted",
        });

        const secondTurn = await withTimeout(stream.nextTurn(), "delegated follow-up turn");
        expect(secondTurn.at(-1)?.type).toBe("session.waiting");
        await expect(waitForRuntimeActionResult(child.runId, "call-2")).resolves.toMatchObject({
          kind: "runtime-action-result",
          results: [
            {
              callId: "call-2",
              kind: "subagent-result",
              output: expect.stringContaining("delegated follow-up turn"),
              subagentName: "researcher",
            },
          ],
        });
        expect(await listCallerStepNames(child.runId)).toEqual([
          "bindTurnCallerContextStep",
          "bindTurnCallerContextStep",
          "notifyTurnCallerStep",
          "notifyTurnCallerStep",
          "resolveInitialTurnCallerStep",
        ]);
      } finally {
        stream.dispose();
        await child.cancel();
      }
    });
  });

  it("forwards continued-turn HITL through the rebound caller", async () => {
    const runtime = await createTestRuntime({
      agent: { name: "workflow-entry-delegated-hitl-rebind" },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineTool({
              approval: always(),
              description: "Apply a change after the user approves it.",
              execute: () => ({ applied: true }),
              inputSchema: {},
            }),
          }),
          logicalPath: "tools/approve_change.ts",
        },
      ],
    });
    const workflowRuntime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const firstCallerToken = "subagent:parent-session:call-1";

    await runtime.run(async () => {
      const child = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "delegated first turn" },
          serializedContext: {
            ...buildSerializedContext({
              channelKind: "subagent",
              channelState: {
                callId: "call-1",
                parentContinuationToken: sessionInboxHookToken(firstCallerToken),
                parentSessionId: "parent-session",
                subagentName: "researcher",
              },
              continuationToken: firstCallerToken,
              mode: "conversation",
            }),
            "eve.capabilities": { requestInput: true },
          },
        },
      ]);
      const stream = captureTurnEvents(child);

      try {
        await withTimeout(stream.nextTurn(), "delegated first turn");
        await waitForRuntimeActionResult(child.runId, "call-1");

        await expect(
          workflowRuntime.dispatchSession({
            command: {
              caller: {
                callId: "call-2",
                replyTo: {
                  kind: "hook",
                  token: sessionInboxHookToken(sessionCommandHookToken(child.runId)),
                },
                subagentName: "researcher",
              },
              kind: "send",
              payload: { message: "Use the approve_change tool exactly once." },
            },
            sessionId: child.runId,
          }),
        ).resolves.toEqual({ sessionId: child.runId, status: "accepted" });

        const secondTurn = await withTimeout(stream.nextTurn(), "delegated HITL turn");
        expect(filterEventsByType(secondTurn, "input.requested")).toHaveLength(1);
        await expect(waitForSubagentInputRequest(child.runId, "call-2")).resolves.toMatchObject({
          callId: "call-2",
          kind: "subagent-input-request",
          subagentName: "researcher",
        });
      } finally {
        stream.dispose();
        await child.cancel();
      }
    });
  }, 60_000);

  it("exits a competing continuation owner before its first turn", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-hook-owner" } });
    const continuationToken = "http:workflow-entry-hook-owner";

    await runtime.run(async () => {
      const owner = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "owner message" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const ownerStream = captureTurnEvents(owner);
      await waitForHook(
        { runId: owner.runId },
        { token: sessionInboxHookToken(continuationToken) },
      );

      const firstTurn = await ownerStream.nextTurn();
      expect(firstTurn.at(-1)?.type).toBe("session.waiting");

      const contender = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          continuationConflictCommand: {
            auth: null,
            kind: "send",
            payload: { message: "contending message" },
          },
          input: { message: "contending message" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      try {
        await expect(contender.returnValue).resolves.toEqual({ output: "" });
        const ownerFollowUp = await ownerStream.nextTurn();

        expect(ownerFollowUp.at(-1)?.type).toBe("session.waiting");
        expect(
          ownerFollowUp.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("contending message") === true,
          ),
        ).toBe(true);
      } finally {
        ownerStream.dispose();
        await owner.cancel();
      }
    });
  });

  it("emits completed structured results for a conversation turn outputSchema", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-output-schema" } });
    const continuationToken = "http:workflow-entry-output-schema";
    const outputSchema = {
      properties: {
        count: { type: "integer" },
        title: { type: "string" },
      },
      required: ["title", "count"],
      type: "object",
    } as const;

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "summarize this", outputSchema },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);

      const stream = captureTurnEvents(run);
      await waitForHook(
        { runId: run.runId },
        {
          token: sessionInboxHookToken(continuationToken),
        },
      );

      try {
        const firstTurn = await stream.nextTurn();
        const results = filterEventsByType(firstTurn, "result.completed");

        expect(results).toHaveLength(1);
        expect(results[0]?.data.result).toEqual({
          count: 1,
          title: "structured-output",
        });
        expect(firstTurn.at(-1)?.type).toBe("session.waiting");

        await resumeHook(sessionInboxHookToken(continuationToken), {
          kind: "send",
          payload: { message: "follow up without structured output" },
        });

        const secondTurn = await stream.nextTurn();

        expect(filterEventsByType(secondTurn, "result.completed")).toHaveLength(0);
        expect(secondTurn.at(-1)?.type).toBe("session.waiting");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("completes immediately in task mode", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-task" } });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: "http:workflow-entry-task",
            mode: "task",
          }),
        },
      ]);

      await expect(run.returnValue).resolves.toEqual({
        output: expect.stringContaining("hello there"),
      });
      await expect(run.status).resolves.toBe("completed");
    });
  });

  it("returns agent-declared structured output in task mode", async () => {
    const outputSchema = {
      properties: {
        summary: { type: "string" },
      },
      required: ["summary"],
      type: "object",
    } as const;
    const runtime = await createTestRuntime({
      agent: { name: "workflow-entry-task-output-schema", outputSchema },
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: "http:workflow-entry-task-output-schema",
            mode: "task",
          }),
        },
      ]);

      await expect(run.returnValue).resolves.toEqual({
        output: { summary: "structured-output" },
      });
      await expect(run.status).resolves.toBe("completed");
    });
  });

  it("emits `$eve.*` session attributes onto the parent workflow run", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-tags" } });
    const continuationToken = "http:workflow-entry-tags";

    await runtime.run(async () => {
      const serializedContext = {
        ...buildSerializedContext({
          audience: "public",
          channelKind: "http",
          continuationToken,
          mode: "conversation",
        }),
        [SessionTitleKey.name]: "session tag round-trip",
      };
      const run = await start(
        workflowEntry,
        [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: "session tag round-trip" },
            serializedContext,
          },
        ],
        {
          allowReservedAttributes: true,
          attributes: normalizeEveAttributes(
            buildSessionAttributes({
              serializedContext,
            }),
          ),
        },
      );

      const stream = captureTurnEvents(run);
      try {
        await stream.nextTurn();

        const world = await getWorld();
        const persisted = await world.runs.get(run.runId);
        const attrs = (persisted as { attributes?: Record<string, string> }).attributes ?? {};

        expect(attrs["$eve.type"]).toBe("session");
        expect(attrs["$eve.is_trace_content_visible"]).toBe("true");
        expect(attrs["$eve.trigger"]).toBe("http");
        expect(attrs["$eve.title"]).toContain("session tag round-trip");
        // Top-level sessions have no parent or subagent name on the root run.
        expect(attrs["$eve.parent"]).toBeUndefined();
        expect(attrs["$eve.subagent"]).toBeUndefined();
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("emits parent lineage onto a subagent workflow run", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-subagent-tags" } });

    await runtime.run(async () => {
      const serializedContext = buildSerializedContext({
        audience: "public",
        channelKind: "subagent",
        continuationToken: "subagent:parent-session:call-subagent-1",
        mode: "task",
        parent: {
          callId: "call-subagent-1",
          rootSessionId: "root-session",
          sessionId: "parent-session",
          turn: { id: "turn-parent", sequence: 2 },
        },
      });
      const run = await start(
        workflowEntry,
        [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: "subagent tag round-trip" },
            serializedContext,
          },
        ],
        {
          allowReservedAttributes: true,
          attributes: normalizeEveAttributes(
            buildSubagentRootAttributes({
              identity: { nodeId: "researcher" },
              parentCallId: "call-subagent-1",
              parentSessionId: "parent-session",
              parentTurnId: "turn-parent",
              rootSessionId: "root-session",
              serializedContext,
            }),
          ),
        },
      );

      await expect(run.returnValue).resolves.toEqual({
        output: expect.stringContaining("subagent tag round-trip"),
      });
      await expect(run.status).resolves.toBe("completed");

      const world = await getWorld();
      const persisted = await world.runs.get(run.runId);
      const attrs = (persisted as { attributes?: Record<string, string> }).attributes ?? {};

      expect(attrs["$eve.type"]).toBe("subagent");
      expect(attrs["$eve.is_trace_content_visible"]).toBe("true");
      expect(attrs["$eve.parent"]).toBe("parent-session");
      expect(attrs["$eve.parent_call"]).toBe("call-subagent-1");
      expect(attrs["$eve.parent_turn"]).toBe("turn-parent");
      expect(attrs["$eve.root"]).toBe("root-session");
      expect(attrs["$eve.trigger"]).toBe("subagent");
    });
  });
});

async function waitForRuntimeActionResult(runId: string, callId: string): Promise<unknown> {
  const world = await getWorld();
  const deadline = Date.now() + 10_000;
  let receivedPayloads: unknown[] = [];

  while (Date.now() < deadline) {
    const events = await world.events.list({
      pagination: { limit: 1000 },
      resolveData: "all",
      runId,
    });
    receivedPayloads = [];

    for (const event of events.data) {
      if (event.eventType === "hook_received") {
        const payload = await hydrateWorkflowArguments(event.eventData.payload, runId, undefined);
        receivedPayloads.push(payload);
        if (hasSubagentResult(payload, callId)) {
          return payload;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out waiting for delegated result "${callId}". Received: ${JSON.stringify(receivedPayloads)}`,
  );
}

async function waitForSubagentInputRequest(runId: string, callId: string): Promise<unknown> {
  const world = await getWorld();
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const events = await world.events.list({
      pagination: { limit: 1000 },
      resolveData: "all",
      runId,
    });
    for (const event of events.data) {
      if (event.eventType !== "hook_received") continue;
      const payload = await hydrateWorkflowArguments(event.eventData.payload, runId, undefined);
      if (
        typeof payload === "object" &&
        payload !== null &&
        "kind" in payload &&
        payload.kind === "subagent-input-request" &&
        "callId" in payload &&
        payload.callId === callId
      ) {
        return payload;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for a subagent input request from caller "${callId}".`);
}

function hasSubagentResult(value: unknown, callId: string): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "runtime-action-result" ||
    !("results" in value) ||
    !Array.isArray(value.results)
  ) {
    return false;
  }

  return value.results.some(
    (result) =>
      typeof result === "object" &&
      result !== null &&
      "callId" in result &&
      result.callId === callId,
  );
}
