import { describe, expect, it } from "vitest";
import { getWorld, resumeHook, start } from "#internal/workflow/runtime.js";

import { createTestRuntime, type TestRuntime } from "#internal/testing/app-harness.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import {
  captureTurnEvents,
  containsEventSequence,
  filterEventsByType,
} from "#internal/testing/events.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createEveSessionCancelRoutePath } from "#protocol/routes.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { createChannelAddress } from "#channel/channel-address.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import { createSession } from "#channel/session.js";
import { none } from "#public/channels/auth.js";
import { eveChannel } from "#public/channels/eve.js";
import { defineMemory } from "#public/memory/index.js";
import type { ToolContext } from "#tools/definition.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { toInputSchema } from "#tools/schema.js";
import { experimental_workflow } from "#tools/workflow.js";

/**
 * Turn cancellation settles as `turn.cancelled` → `session.waiting` with
 * zero failure events, no step retries, and a session that accepts the next
 * message normally. Coverage exercises direct hooks, the HTTP trigger, the
 * continuation-addressed channel helper, and layer-3 cancellation of adopted
 * local descendants.
 */

const FAILURE_EVENT_TYPES = ["step.failed", "turn.failed", "session.failed"] as const;
const WAIT_TOOL_NAME = "wait_for_cancel";

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

/**
 * Builds an authored tool that hangs until the layer-0 turn signal
 * aborts, then rejects with the signal's reason — the deterministic
 * mid-turn anchor for cancellation tests.
 */
function buildWaitForCancelTool(
  onStart: () => void,
  onAbort: () => void,
  completion?: Promise<void>,
): ResolvedToolDefinition {
  return {
    description: "Waits until the turn is cancelled.",
    execute: (_input: unknown, rawCtx: unknown) => {
      const ctx = rawCtx as ToolContext;
      onStart();
      return new Promise((resolve, reject) => {
        const abort = (): void => {
          onAbort();
          reject(ctx.abortSignal.reason);
        };
        if (ctx.abortSignal.aborted) {
          abort();
          return;
        }
        ctx.abortSignal.addEventListener("abort", abort, { once: true });
        void completion?.then(() => {
          ctx.abortSignal.removeEventListener("abort", abort);
          resolve("Work completed successfully.");
        });
      });
    },
    inputSchema: toInputSchema({ additionalProperties: false, properties: {}, type: "object" }),
    logicalPath: `tools/${WAIT_TOOL_NAME}.ts`,
    name: WAIT_TOOL_NAME,
    owner: { kind: "application" },
    sourceId: `tools/${WAIT_TOOL_NAME}.ts`,
    sourceKind: "module",
  };
}

interface WaitToolFixture {
  readonly runtime: TestRuntime;
  readonly toolStarted: Promise<void>;
  toolAborts(): number;
  toolStarts(): number;
}

async function createWaitToolRuntime(
  agentName: string,
  completion?: Promise<void>,
): Promise<WaitToolFixture> {
  let aborts = 0;
  let starts = 0;
  let resolveStarted: (() => void) | undefined;
  const toolStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const waitTool = buildWaitForCancelTool(
    () => {
      starts += 1;
      resolveStarted?.();
    },
    () => {
      aborts += 1;
    },
    completion,
  );
  const runtime = await createTestRuntime({
    agent: { name: agentName },
    modules: [
      {
        loadNamespace: async () => ({ default: experimental_workflow() }),
        logicalPath: "tools/workflow.ts",
      },
    ],
    tools: [waitTool],
  });
  const manifestTool = runtime.manifest.tools.find((tool) => tool.name === WAIT_TOOL_NAME);
  if (manifestTool === undefined) {
    throw new Error(`Expected ${WAIT_TOOL_NAME} to be present in the test manifest.`);
  }
  runtime.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[manifestTool.sourceId] = {
    default: { execute: waitTool.execute },
  };
  return { runtime, toolStarted, toolAborts: () => aborts, toolStarts: () => starts };
}

interface AbortRecallFixture {
  readonly recallStarted: Promise<void>;
  readonly runtime: TestRuntime;
  recalls(): readonly {
    readonly input: string;
    readonly messages: string;
    readonly sequence: number;
  }[];
}

function abortError(): Error {
  return Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
}

async function createAbortRecallRuntime(
  agentName: string,
  options: { readonly waitForAbort: boolean },
): Promise<AbortRecallFixture> {
  let resolveRecallStarted: (() => void) | undefined;
  const recallStarted = new Promise<void>((resolve) => {
    resolveRecallStarted = resolve;
  });
  const recalls: Array<{ input: string; messages: string; sequence: number }> = [];
  const runtime = await createTestRuntime({
    agent: { name: agentName },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineMemory({
            provider: {
              recall: {
                "turn.started": async (context) => {
                  recalls.push({
                    input: JSON.stringify(context.turn.input),
                    messages: JSON.stringify(context.messages),
                    sequence: context.turn.sequence,
                  });
                  if (context.turn.sequence > 0) return null;

                  resolveRecallStarted?.();
                  if (!options.waitForAbort) {
                    throw abortError();
                  }

                  return await new Promise((_resolve, reject) => {
                    const abort = (): void => {
                      reject(abortError());
                    };
                    if (context.abortSignal.aborted) {
                      abort();
                      return;
                    }
                    context.abortSignal.addEventListener("abort", abort, { once: true });
                  });
                },
              },
            },
            scope: "test",
          }),
        }),
        logicalPath: "memory/abort-recall.ts",
      },
    ],
  });

  return { recallStarted, recalls: () => recalls, runtime };
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

async function waitForValue(read: () => number, expected: number, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (read() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for value ${String(expected)}.`);
}

/**
 * The retry canary: an aborted `turnStep` settles by *returning*, so the
 * owning session run must record no `step_failed`/`step_retrying` events
 * (nothing thrown ever crosses the step boundary) and at most one
 * `step_completed` per correlation id. Duplicate `step_started` entries
 * are allowed: the runtime may supersede an aborted attempt and
 * re-dispatch the step under the same correlation id — the entry abort
 * check makes the superseding attempt side-effect free.
 */
async function expectNoStepRetries(runId: string): Promise<void> {
  const world = await getWorld();
  const completions = new Map<string, number>();
  const failureEvents: string[] = [];
  let cursor: string | undefined;

  do {
    const pagination: { cursor?: string; limit: number } = { limit: 1000 };
    if (cursor !== undefined) {
      pagination.cursor = cursor;
    }
    const page = await world.events.list({ pagination, resolveData: "none", runId });
    const events: readonly { correlationId?: string | null; eventType?: string }[] = page.data;
    for (const event of events) {
      if (event.eventType === "step_failed" || event.eventType === "step_retrying") {
        failureEvents.push(`${event.eventType}:${String(event.correlationId ?? "?")}`);
      }
      if (event.eventType === "step_completed") {
        const correlationId = String(event.correlationId ?? "?");
        completions.set(correlationId, (completions.get(correlationId) ?? 0) + 1);
      }
    }
    cursor = page.hasMore === true && page.cursor !== null ? page.cursor : undefined;
  } while (cursor !== undefined);

  expect(failureEvents).toEqual([]);
  expect([...completions.entries()].filter(([, count]) => count > 1)).toEqual([]);
}

function expectNoFailureEvents(events: readonly UnstampedMessageStreamEvent[]): void {
  const types = events.map((event) => event.type);
  for (const failureType of FAILURE_EVENT_TYPES) {
    expect(types).not.toContain(failureType);
  }
}

/** Builds a cancel-route caller backed by the workflow runtime. */
function createCancelRouteCaller(): (
  sessionId: string,
  body?: { readonly turnId?: string },
) => Promise<Response> {
  const channel = eveChannel({ auth: none() });
  const cancelRoute = (
    channel.routes as readonly { method: string; path: string; handler?: unknown }[]
  ).find((route) => route.method === "POST" && route.path === "/eve/v1/session/:sessionId/cancel");
  if (cancelRoute?.handler === undefined) {
    throw new Error("Expected eveChannel() to register the cancel-turn route.");
  }
  const handler = cancelRoute.handler as (
    req: Request,
    args: RouteHandlerArgs,
  ) => Promise<Response>;
  const runtime = createWorkflowRuntime({
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
  });

  return async (sessionId, body) => {
    const request = new Request(
      `https://example.com${createEveSessionCancelRoutePath(sessionId)}`,
      {
        method: "POST",
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      },
    );
    const args = {
      ...mockChannelContext(() => {
        throw new Error("cancel route must not send through a channel address");
      }),
      attachSession: (id: string) => createSession(id, runtime),
      to: () => {
        throw new Error("cancel route must not send to another channel");
      },
      params: { sessionId },
      waitUntil: () => undefined,
      requestIp: "127.0.0.1",
    } satisfies RouteHandlerArgs;
    return await handler(request, args);
  };
}

async function expectCancelResponse(
  response: Response,
  expected:
    | { readonly sessionId: string; readonly status: "accepted" }
    | { readonly status: "no_active_turn" },
): Promise<void> {
  expect(response.status).toBe(expected.status === "accepted" ? 202 : 200);
  await expect(response.json()).resolves.toEqual(
    expected.status === "accepted"
      ? { ok: true, sessionId: expected.sessionId, status: "accepted" }
      : { ok: true, status: "no_active_turn" },
  );
}

describe("turn cancellation integration", () => {
  it("settles an abort-shaped memory recall error after explicit cancellation", async () => {
    const fixture = await createAbortRecallRuntime("turn-steer-memory-recall", {
      waitForAbort: true,
    });
    const rawToken = "turn-steer-memory-recall";
    const continuationToken = `http:${rawToken}`;
    const workflowRuntime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const address = createChannelAddress({
      adapter: { kind: "http" },
      channelName: "http",
      continuationToken: rawToken,
      runtime: workflowRuntime,
    });

    await fixture.runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "remember this interrupted request" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        await waitForHookByToken(continuationToken);
        await fixture.recallStarted;

        await resumeHook(sessionCommandHookToken(run.runId), { kind: "cancel" });
        await expect(
          address.send("replacement after recall abort", { auth: null }),
        ).resolves.toMatchObject({ id: run.runId });

        const cancelledTurn = await stream.nextTurn();
        expect(
          containsEventSequence(cancelledTurn, [
            "turn.started",
            "turn.cancelled",
            "session.waiting",
          ]),
        ).toBe(true);
        expectNoFailureEvents(cancelledTurn);
        await expectNoStepRetries(run.runId);

        const replacementTurn = await stream.nextTurn();
        expect(filterEventsByType(replacementTurn, "turn.started")).toHaveLength(1);
        expect(filterEventsByType(replacementTurn, "turn.cancelled")).toHaveLength(0);
        expectNoFailureEvents(replacementTurn);
        expect(
          replacementTurn.some(
            (event) =>
              event.type === "message.received" &&
              typeof event.data.message === "string" &&
              event.data.message.includes("replacement after recall abort"),
          ),
        ).toBe(true);

        const replacementRecall = fixture.recalls().find((recall) => recall.sequence === 1);
        expect(replacementRecall?.messages).toContain("remember this interrupted request");
        expect(replacementRecall?.input).toContain("replacement after recall abort");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  it("keeps an abort-shaped memory recall error terminal while the turn signal is active", async () => {
    const fixture = await createAbortRecallRuntime("turn-active-memory-abort", {
      waitForAbort: false,
    });

    await fixture.runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "fail memory recall" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: "http:turn-active-memory-abort",
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        await fixture.recallStarted;
        const failedTurn = await stream.nextTurn();
        expect(failedTurn.at(-1)?.type).toBe("session.failed");
        expect(filterEventsByType(failedTurn, "turn.cancelled")).toHaveLength(0);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it.each([
    { turnPolicy: undefined, turnCount: 1 },
    { turnPolicy: "steer" as const, turnCount: 1 },
    { turnPolicy: "queue" as const, turnCount: 2 },
  ])(
    "admits $turnPolicy deliveries without aborting ($turnCount turns)",
    async ({ turnPolicy, turnCount }) => {
      let finishWork!: () => void;
      const completion = new Promise<void>((resolve) => {
        finishWork = resolve;
      });
      const fixture = await createWaitToolRuntime("turn-steer-message", completion);
      const rawToken = "turn-steer-message";
      const continuationToken = `http:${rawToken}`;
      const workflowRuntime = createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const address = createChannelAddress({
        adapter: { kind: "http" },
        channelName: "http",
        continuationToken: rawToken,
        runtime: workflowRuntime,
      });

      await fixture.runtime.run(async () => {
        const run = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: `Use the ${WAIT_TOOL_NAME} tool.` },
            serializedContext: buildSerializedContext({
              channelKind: "http",
              continuationToken,
              mode: "conversation",
            }),
          },
        ]);
        const stream = captureTurnEvents(run);

        try {
          await waitForHookByToken(continuationToken);
          await fixture.toolStarted;

          await expect(
            address.send("follow-up after work", { auth: null, turnPolicy }),
          ).resolves.toMatchObject({ id: run.runId });

          finishWork();
          const events = await stream.nextTurn();
          if (turnCount === 2) events.push(...(await stream.nextTurn()));
          expect(fixture.toolAborts()).toBe(0);
          expect(filterEventsByType(events, "turn.started")).toHaveLength(turnCount);
          expect(filterEventsByType(events, "turn.cancelled")).toHaveLength(0);
          expectNoFailureEvents(events);
          expect(
            events.some(
              (event) =>
                event.type === "message.received" &&
                typeof event.data.message === "string" &&
                event.data.message.includes("follow-up after work"),
            ),
          ).toBe(true);
        } finally {
          finishWork();
          stream.dispose();
          await run.cancel();
        }
      });
    },
    60_000,
  );

  it("cancels a turn mid-tool and accepts the next message normally", async () => {
    const fixture = await createWaitToolRuntime("turn-cancel-tool");
    const continuationToken = "http:turn-cancel-tool";

    await fixture.runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: `Use the ${WAIT_TOOL_NAME} tool.` },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const commandToken = sessionCommandHookToken(run.runId);
        await waitForHookByToken(commandToken);
        await fixture.toolStarted;
        // A matching turn guard cancels the observed turn (the first
        // turn's id is `turn_0`).
        await resumeHook(commandToken, { kind: "cancel", turnId: "turn_0" });

        const cancelledTurn = await stream.nextTurn();

        // A duplicate cancel after the turn settled is consumed by the
        // parked owner and must not disturb the session.
        await resumeHook(commandToken, { kind: "cancel" });

        expect(cancelledTurn.at(-1)?.type).toBe("session.waiting");
        expect(
          containsEventSequence(cancelledTurn, [
            "turn.started",
            "turn.cancelled",
            "session.waiting",
          ]),
        ).toBe(true);
        expect(filterEventsByType(cancelledTurn, "turn.started")).toHaveLength(1);
        expect(filterEventsByType(cancelledTurn, "turn.cancelled")).toHaveLength(1);
        // The superseding step attempt settles before any model work, so
        // the cancelled turn streams exactly one step.
        expect(filterEventsByType(cancelledTurn, "step.started")).toHaveLength(1);
        expectNoFailureEvents(cancelledTurn);
        expect(fixture.toolStarts()).toBe(1);

        await expectNoStepRetries(run.runId);

        await waitForHook({ runId: run.runId }, { token: continuationToken });
        await resumeHook(continuationToken, {
          kind: "send",
          payload: { message: "follow up after cancel" },
        });

        const followUpTurn = await stream.nextTurn();

        expect(followUpTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(followUpTurn, "turn.cancelled")).toHaveLength(0);
        expectNoFailureEvents(followUpTurn);
        expect(
          followUpTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("follow up after cancel") === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("cancels a turn through the eve channel cancel route", async () => {
    const fixture = await createWaitToolRuntime("turn-cancel-route");
    const continuationToken = "http:turn-cancel-route";
    const cancelViaRoute = createCancelRouteCaller();

    await fixture.runtime.run(async () => {
      await expectCancelResponse(await cancelViaRoute("missing-session"), {
        status: "no_active_turn",
      });

      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: `Use the ${WAIT_TOOL_NAME} tool.` },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        await waitForHookByToken(sessionCommandHookToken(run.runId));
        await fixture.toolStarted;

        const cancelled = await cancelViaRoute(run.runId);
        await expectCancelResponse(cancelled, { sessionId: run.runId, status: "accepted" });

        const cancelledTurn = await stream.nextTurn();

        expect(cancelledTurn.at(-1)?.type).toBe("session.waiting");
        expect(
          containsEventSequence(cancelledTurn, [
            "turn.started",
            "turn.cancelled",
            "session.waiting",
          ]),
        ).toBe(true);
        expect(filterEventsByType(cancelledTurn, "turn.cancelled")).toHaveLength(1);
        expectNoFailureEvents(cancelledTurn);
        expect(fixture.toolAborts()).toBe(1);

        const started = filterEventsByType(cancelledTurn, "turn.started")[0];
        if (started === undefined) throw new Error("Expected the cancelled turn to have started.");

        // The stable inbox remains owned while the session is parked, so a
        // guarded duplicate is harmless even if another alias resolves first.
        const duplicate = await cancelViaRoute(run.runId, { turnId: started.data.turnId });
        await expectCancelResponse(duplicate, { sessionId: run.runId, status: "accepted" });

        await waitForHook({ runId: run.runId }, { token: continuationToken });
        await resumeHook(continuationToken, {
          kind: "send",
          payload: { message: "follow up after route cancel" },
        });

        const followUpTurn = await stream.nextTurn();

        expect(followUpTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(followUpTurn, "turn.cancelled")).toHaveLength(0);
        expectNoFailureEvents(followUpTurn);
        expect(
          followUpTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("follow up after route cancel") === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  it("cancels a turn from a channel route helper addressed by continuation token", async () => {
    const fixture = await createWaitToolRuntime("turn-cancel-helper");
    const rawToken = "turn-cancel-helper";
    const continuationToken = `http:${rawToken}`;
    const workflowRuntime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const address = (continuationToken: string) =>
      createChannelAddress({
        adapter: { kind: "http" },
        channelName: "http",
        continuationToken,
        runtime: workflowRuntime,
      });

    await fixture.runtime.run(async () => {
      // A token no session owns is the benign "nothing to cancel" success
      // and must never start a session.
      await expect(address("no-such-thread").cancel()).resolves.toEqual({
        status: "no_active_turn",
      });

      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: `Use the ${WAIT_TOOL_NAME} tool.` },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        await waitForHookByToken(continuationToken);
        await fixture.toolStarted;

        await expect(address(rawToken).cancel()).resolves.toEqual({
          sessionId: run.runId,
          status: "accepted",
        });

        const cancelledTurn = await stream.nextTurn();

        expect(cancelledTurn.at(-1)?.type).toBe("session.waiting");
        expect(
          containsEventSequence(cancelledTurn, [
            "turn.started",
            "turn.cancelled",
            "session.waiting",
          ]),
        ).toBe(true);
        expect(filterEventsByType(cancelledTurn, "turn.cancelled")).toHaveLength(1);
        expectNoFailureEvents(cancelledTurn);
        expect(fixture.toolAborts()).toBe(1);

        // Session.cancel() addresses the same parked session by its stable ID.
        const session = createSession(run.runId, workflowRuntime);
        await expect(session.cancel()).resolves.toEqual({
          sessionId: run.runId,
          status: "accepted",
        });

        await expect(
          workflowRuntime.dispatchContinuation({
            command: { kind: "send", payload: { message: "follow up after helper cancel" } },
            continuationToken,
          }),
        ).resolves.toEqual({ sessionId: run.runId, status: "accepted" });

        const followUpTurn = await stream.nextTurn();

        expect(followUpTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(followUpTurn, "turn.cancelled")).toHaveLength(0);
        expectNoFailureEvents(followUpTurn);
        expect(
          followUpTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("follow up after helper cancel") === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  it("cascades cancellation to an in-flight subagent and does not re-dispatch it", async () => {
    const fixture = await createWaitToolRuntime("turn-cancel-subagent");
    const continuationToken = "http:turn-cancel-subagent";

    await fixture.runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: {
            message: `Delegate through Workflow to a subagent: use the ${WAIT_TOOL_NAME} tool.`,
          },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        // The child (a fresh copy of the same agent) hangs on the wait
        // tool, holding the parent in `waitForRuntimeActionResults`.
        await fixture.toolStarted;

        const cancelToken = sessionCommandHookToken(run.runId);
        await waitForHookByToken(cancelToken);
        await resumeHook(cancelToken, { kind: "cancel" });

        const cancelledTurn = await stream.nextTurn();

        expect(cancelledTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(cancelledTurn, "turn.cancelled")).toHaveLength(1);
        expect(filterEventsByType(cancelledTurn, "subagent.called")).toHaveLength(1);
        expectNoFailureEvents(cancelledTurn);

        const childSessionId = filterEventsByType(cancelledTurn, "subagent.called")[0]?.data
          .childSessionId;
        expect(childSessionId).toBeDefined();
        await waitForValue(fixture.toolAborts, 1);
        expect(fixture.toolAborts()).toBe(1);

        // The cleared pending batch must not re-dispatch on the next turn.
        await waitForHook({ runId: run.runId }, { token: continuationToken });
        await resumeHook(continuationToken, {
          kind: "send",
          payload: { message: "follow up after subagent cancel" },
        });

        const followUpTurn = await stream.nextTurn();

        expect(followUpTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(followUpTurn, "subagent.called")).toHaveLength(0);
        expect(filterEventsByType(followUpTurn, "turn.cancelled")).toHaveLength(0);
        expectNoFailureEvents(followUpTurn);
        expect(
          followUpTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("follow up after subagent cancel") === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  it("cancels a turn parked on a child HITL request without corrupting the stream", async () => {
    const runtime = await createTestRuntime({
      agent: { name: "turn-cancel-hitl" },
      modules: [
        {
          loadNamespace: async () => ({ default: experimental_workflow() }),
          logicalPath: "tools/workflow.ts",
        },
      ],
    });
    const continuationToken = "http:turn-cancel-hitl";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: {
            message:
              "Delegate through Workflow to a subagent: Use the ask_question tool exactly once.",
          },
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
        // The child asks a question; the proxy epilogue emits this turn's
        // waiting boundary while the parent keeps waiting on the child.
        const hitlTurn = await stream.nextTurn();
        expect(hitlTurn.at(-1)?.type, JSON.stringify(hitlTurn.at(-1), null, 2)).toBe(
          "session.waiting",
        );
        const requested = filterEventsByType(hitlTurn, "input.requested");
        expect(requested).toHaveLength(1);
        const requestId = requested[0]?.data.requests[0]?.requestId;
        expect(requestId).toBeDefined();
        const childSessionId = filterEventsByType(hitlTurn, "subagent.called")[0]?.data
          .childSessionId;
        expect(childSessionId).toBeDefined();

        const cancelToken = sessionCommandHookToken(run.runId);
        await waitForHookByToken(cancelToken);
        await resumeHook(cancelToken, { kind: "cancel" });

        // The boundary is already on the stream: settling must not emit a
        // fabricated turn.cancelled or a second session.waiting.
        const answer = {
          kind: "send",
          payload: {
            inputResponses: [{ requestId: requestId ?? "", text: "blue" }],
            message: "answer after hitl cancel",
          },
        };
        await waitForHook({ runId: run.runId }, { token: continuationToken });
        await resumeHook(continuationToken, answer);

        const followUpTurn = await stream.nextTurn();

        expect(followUpTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(followUpTurn, "turn.cancelled")).toHaveLength(0);
        expect(filterEventsByType(followUpTurn, "turn.started")).toHaveLength(1);
        expect(filterEventsByType(followUpTurn, "step.completed")).toHaveLength(1);
        expect(filterEventsByType(followUpTurn, "session.waiting")).toHaveLength(1);
        expectNoFailureEvents(followUpTurn);
        expect(
          followUpTurn.some(
            (event) =>
              event.type === "message.received" &&
              typeof event.data.message === "string" &&
              event.data.message.includes("answer after hitl cancel"),
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  it("consumes a cancel with a stale turn guard as a no-op and keeps the turn running", async () => {
    const fixture = await createWaitToolRuntime("turn-cancel-stale-guard");
    const continuationToken = "http:turn-cancel-stale-guard";

    await fixture.runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: `Use the ${WAIT_TOOL_NAME} tool.` },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const cancelToken = sessionCommandHookToken(run.runId);
        await waitForHookByToken(cancelToken);
        await fixture.toolStarted;

        // A guard naming a turn the session has never run: the payload is
        // consumed as a no-op — the caller's cancel must never leak onto
        // a turn they did not observe.
        await resumeHook(cancelToken, { kind: "cancel", turnId: "turn_99" });

        // The turn must still be cancellable afterwards: the skip loop
        // re-arms the durable read rather than consuming the hook.
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(fixture.toolAborts()).toBe(0);

        await resumeHook(cancelToken, { kind: "cancel", turnId: "turn_0" });

        const cancelledTurn = await stream.nextTurn();

        expect(cancelledTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(cancelledTurn, "turn.cancelled")).toHaveLength(1);
        expectNoFailureEvents(cancelledTurn);
        expect(fixture.toolAborts()).toBe(1);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  it("treats a cancel after the turn settled as a benign no-op", async () => {
    const runtime = await createTestRuntime({ agent: { name: "turn-cancel-late" } });
    const continuationToken = "http:turn-cancel-late";

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
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const firstTurn = await stream.nextTurn();
        expect(firstTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(firstTurn, "turn.completed")).toHaveLength(1);

        // The stable inbox accepts a late cancel and the parked owner consumes it as a no-op.
        await resumeHook(sessionCommandHookToken(run.runId), { kind: "cancel" });

        await waitForHook({ runId: run.runId }, { token: continuationToken });
        await resumeHook(continuationToken, {
          kind: "send",
          payload: { message: "follow up after late cancel" },
        });

        const secondTurn = await stream.nextTurn();

        expect(secondTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(secondTurn, "turn.cancelled")).toHaveLength(0);
        expectNoFailureEvents(secondTurn);
        expect(
          secondTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("follow up after late cancel") === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});
