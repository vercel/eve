import { describe, expect, it } from "vitest";
import { getWorld, resumeHook, start } from "#internal/workflow/runtime.js";

import { createTestRuntime, type TestRuntime } from "#internal/testing/app-harness.js";
import {
  captureTurnEvents,
  containsEventSequence,
  filterEventsByType,
} from "#internal/testing/events.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { sessionCancelHookToken } from "#execution/turn-cancellation-token.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createEveCancelTurnRoutePath } from "#protocol/routes.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { createCancelFn } from "#channel/cancel.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import { createSession } from "#channel/session.js";
import { none } from "#public/channels/auth.js";
import { eveChannel } from "#public/channels/eve.js";
import type { Agent } from "#public/definitions/channel.js";
import type { ToolContext } from "#public/definitions/tool.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { attachRouteAgent } from "#internal/nitro/routes/channel-route-context.js";
import { toInputSchema } from "#shared/tool-schema.js";

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
function buildWaitForCancelTool(onStart: () => void, onAbort: () => void): ResolvedToolDefinition {
  return {
    description: "Waits until the turn is cancelled.",
    execute: (_input: unknown, rawCtx: unknown) => {
      const ctx = rawCtx as ToolContext;
      onStart();
      return new Promise((_resolve, reject) => {
        const abort = (): void => {
          onAbort();
          reject(ctx.abortSignal.reason);
        };
        if (ctx.abortSignal.aborted) {
          abort();
          return;
        }
        ctx.abortSignal.addEventListener("abort", abort, { once: true });
      });
    },
    inputSchema: toInputSchema({ additionalProperties: false, properties: {}, type: "object" }),
    logicalPath: `tools/${WAIT_TOOL_NAME}.ts`,
    name: WAIT_TOOL_NAME,
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

function createWaitToolRuntime(agentName: string): WaitToolFixture {
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
  );
  const runtime = createTestRuntime({ agent: { name: agentName }, tools: [waitTool] });
  const manifestTool = runtime.manifest.tools.find((tool) => tool.name === WAIT_TOOL_NAME);
  if (manifestTool === undefined) {
    throw new Error(`Expected ${WAIT_TOOL_NAME} to be present in the test manifest.`);
  }
  runtime.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[manifestTool.sourceId] = {
    default: { execute: waitTool.execute },
  };
  return { runtime, toolStarted, toolAborts: () => aborts, toolStarts: () => starts };
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

/** Polls the world until a hook token is swept (terminal-run cleanup). */
async function waitForHookSweep(token: string, timeout = 15_000): Promise<void> {
  const world = await getWorld();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hook = await world.hooks.getByToken(token).catch(() => null);
    if (hook === null || hook === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for hook token "${token}" to be swept.`);
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

/**
 * The retry canary: an aborted `turnStep` settles by *returning*, so the
 * turn workflow run must record no `step_failed`/`step_retrying` events
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

function expectNoFailureEvents(events: readonly HandleMessageStreamEvent[]): void {
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
  const agent: Agent = {
    cancelTurn: (input) => runtime.cancelTurn(input),
    async deliver() {
      throw new Error("cancel route must not deliver");
    },
    async getEventStream() {
      throw new Error("cancel route must not read events");
    },
    async run() {
      throw new Error("cancel route must not start a session");
    },
  };

  return async (sessionId, body) => {
    const request = new Request(`https://example.com${createEveCancelTurnRoutePath(sessionId)}`, {
      method: "POST",
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    const args = attachRouteAgent(
      {
        send: () => {
          throw new Error("cancel route must not send");
        },
        cancel: () => {
          throw new Error("cancel route must not use the channel cancel helper");
        },
        getSession: () => {
          throw new Error("cancel route must not get a session");
        },
        receive: () => {
          throw new Error("cancel route must not receive");
        },
        params: { sessionId },
        waitUntil: () => undefined,
        requestIp: "127.0.0.1",
      } satisfies RouteHandlerArgs,
      agent,
    );
    return await handler(request, args);
  };
}

async function expectCancelResponse(
  response: Response,
  expected: { readonly sessionId: string; readonly status: "accepted" | "no_active_turn" },
): Promise<void> {
  expect(response.status).toBe(202);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    sessionId: expected.sessionId,
    status: expected.status,
  });
}

describe("turn cancellation integration", () => {
  it("cancels a turn mid-tool and accepts the next message normally", async () => {
    const fixture = createWaitToolRuntime("turn-cancel-tool");
    const continuationToken = "http:turn-cancel-tool";

    await fixture.runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
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
        const cancelToken = sessionCancelHookToken(run.runId);
        const cancelHook = await waitForHookByToken(cancelToken);
        await fixture.toolStarted;
        // A matching turn guard cancels the observed turn (the first
        // turn's id is `turn_0`).
        await resumeHook(cancelToken, { turnId: "turn_0" });

        const cancelledTurn = await stream.nextTurn();

        // A duplicate cancel after the turn settled lands on a
        // consumed/disposed hook and must not disturb the session.
        await resumeHook(cancelToken, {}).catch(() => undefined);

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

        await expectNoStepRetries(cancelHook.runId);

        await waitForHook({ runId: run.runId }, { token: continuationToken });
        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "follow up after cancel" }],
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
    const fixture = createWaitToolRuntime("turn-cancel-route");
    const continuationToken = "http:turn-cancel-route";
    const cancelViaRoute = createCancelRouteCaller();

    await fixture.runtime.run(async () => {
      await expectCancelResponse(await cancelViaRoute("missing-session"), {
        sessionId: "missing-session",
        status: "no_active_turn",
      });

      const run = await start(workflowEntry, [
        {
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
        await waitForHookByToken(sessionCancelHookToken(run.runId));
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

        // With the turn settled and its cancel hook swept from the
        // world, a duplicate cancel is the benign "nothing to cancel"
        // success. (Between settle and sweep a duplicate may still be
        // accepted as "accepted" and land unconsumed — also benign.)
        await waitForHookSweep(sessionCancelHookToken(run.runId));
        const duplicate = await cancelViaRoute(run.runId);
        await expectCancelResponse(duplicate, { sessionId: run.runId, status: "no_active_turn" });

        await waitForHook({ runId: run.runId }, { token: continuationToken });
        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "follow up after route cancel" }],
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
    const fixture = createWaitToolRuntime("turn-cancel-helper");
    const rawToken = "turn-cancel-helper";
    const continuationToken = `http:${rawToken}`;
    const workflowRuntime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const cancel = createCancelFn(workflowRuntime, "http");

    await fixture.runtime.run(async () => {
      // A token no session owns is the benign "nothing to cancel" success
      // and must never start a session.
      await expect(cancel({ continuationToken: "no-such-thread" })).resolves.toEqual({
        status: "no_active_turn",
      });

      const run = await start(workflowEntry, [
        {
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

        await expect(cancel({ continuationToken: rawToken })).resolves.toEqual({
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

        // Session.cancel() addresses the same session by id. With the turn
        // settled and its cancel hook swept, it reports the benign status.
        await waitForHookSweep(sessionCancelHookToken(run.runId));
        const session = createSession(run.runId, rawToken, workflowRuntime);
        await expect(session.cancel()).resolves.toEqual({ status: "no_active_turn" });

        await waitForHook({ runId: run.runId }, { token: continuationToken });
        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "follow up after helper cancel" }],
        });

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
    const fixture = createWaitToolRuntime("turn-cancel-subagent");
    const continuationToken = "http:turn-cancel-subagent";

    await fixture.runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: `Delegate to a subagent: use the ${WAIT_TOOL_NAME} tool.` },
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

        const cancelToken = sessionCancelHookToken(run.runId);
        await waitForHookByToken(cancelToken);
        await resumeHook(cancelToken, {});

        const cancelledTurn = await stream.nextTurn();

        expect(cancelledTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(cancelledTurn, "turn.cancelled")).toHaveLength(1);
        expect(filterEventsByType(cancelledTurn, "subagent.called")).toHaveLength(1);
        expectNoFailureEvents(cancelledTurn);

        const childSessionId = filterEventsByType(cancelledTurn, "subagent.called")[0]?.data
          .childSessionId;
        expect(childSessionId).toBeDefined();
        await waitForHookSweep(sessionCancelHookToken(childSessionId ?? ""));
        expect(fixture.toolAborts()).toBe(1);

        // The cleared pending batch must not re-dispatch on the next turn.
        await waitForHook({ runId: run.runId }, { token: continuationToken });
        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "follow up after subagent cancel" }],
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
    const runtime = createTestRuntime({ agent: { name: "turn-cancel-hitl" } });
    const continuationToken = "http:turn-cancel-hitl";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "Delegate to a subagent: Use the ask_question tool exactly once." },
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
        expect(hitlTurn.at(-1)?.type).toBe("session.waiting");
        const requested = filterEventsByType(hitlTurn, "input.requested");
        expect(requested).toHaveLength(1);
        const requestId = requested[0]?.data.requests[0]?.requestId;
        expect(requestId).toBeDefined();
        const childSessionId = filterEventsByType(hitlTurn, "subagent.called")[0]?.data
          .childSessionId;
        expect(childSessionId).toBeDefined();

        const cancelToken = sessionCancelHookToken(run.runId);
        const cancelHook = await waitForHookByToken(cancelToken);
        await resumeHook(cancelToken, {});
        // Barrier: the answer must not race the cancel — a delivery that
        // beats the cancel is legitimately routed to the still-live child.
        await waitForRunCompletion(cancelHook.runId);

        // The boundary is already on the stream: settling must not emit a
        // fabricated turn.cancelled or a second session.waiting.
        const world = await getWorld();
        const answer = {
          kind: "deliver",
          payloads: [
            {
              inputResponses: [{ requestId: requestId ?? "", text: "blue" }],
              message: "answer after hitl cancel",
            },
          ],
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

        // The cleared proxy map must not route the answer to the orphaned
        // child: the child never starts a second turn.
        const childSecondTurnInbox = `${childSessionId ?? ""}:turn-control:1:inbox`;
        const deadline = Date.now() + 1_500;
        while (Date.now() < deadline) {
          const hook = await world.hooks.getByToken(childSecondTurnInbox).catch(() => null);
          expect(hook ?? null).toBeNull();
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  it("consumes a cancel with a stale turn guard as a no-op and keeps the turn running", async () => {
    const fixture = createWaitToolRuntime("turn-cancel-stale-guard");
    const continuationToken = "http:turn-cancel-stale-guard";

    await fixture.runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
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
        const cancelToken = sessionCancelHookToken(run.runId);
        await waitForHookByToken(cancelToken);
        await fixture.toolStarted;

        // A guard naming a turn the session has never run: the payload is
        // consumed as a no-op — the caller's cancel must never leak onto
        // a turn they did not observe.
        await resumeHook(cancelToken, { turnId: "turn_99" });

        // The turn must still be cancellable afterwards: the skip loop
        // re-arms the durable read rather than consuming the hook.
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(fixture.toolAborts()).toBe(0);

        await resumeHook(cancelToken, { turnId: "turn_0" });

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
    const runtime = createTestRuntime({ agent: { name: "turn-cancel-late" } });
    const continuationToken = "http:turn-cancel-late";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
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

        // The turn workflow has settled and disposed its cancel hook; a
        // late cancel either rejects (hook gone) or lands unconsumed.
        await resumeHook(sessionCancelHookToken(run.runId), {}).catch(() => undefined);

        await waitForHook({ runId: run.runId }, { token: continuationToken });
        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "follow up after late cancel" }],
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

  it("completes settled turn runs so the world sweeps their hooks", async () => {
    const runtime = createTestRuntime({ agent: { name: "turn-cancel-sweep" } });
    const continuationToken = "http:turn-cancel-sweep";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "first turn" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");

        await waitForHook({ runId: run.runId }, { token: continuationToken });
        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "second turn" }],
        });
        expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");

        // Teardown must not await the cancel hook's outstanding read: a
        // turn run that never returns stays `running` forever and its
        // hooks are never swept. With the session parked, no cancel hook
        // may remain in the world.
        const world = await getWorld();
        const deadline = Date.now() + 15_000;
        let completedTurnRuns = 0;
        let cancelHooks = 0;
        while (Date.now() < deadline) {
          const cancelToken0 = sessionCancelHookToken(run.runId);
          const cancelHook0 = await world.hooks.getByToken(cancelToken0).catch(() => null);
          cancelHooks = cancelHook0 === null ? 0 : 1;

          const runsPage = await world.runs.list({ pagination: { limit: 100 } });
          completedTurnRuns = runsPage.data.filter(
            (row: { status?: string; workflowName?: string }) =>
              row.workflowName?.includes("turnWorkflow") === true && row.status === "completed",
          ).length;

          if (completedTurnRuns >= 1 && cancelHooks === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // The first turn settled a full turn ago: its run must have
        // completed and its cancel hook must be gone from the world.
        expect(completedTurnRuns).toBeGreaterThanOrEqual(1);
        expect(cancelHooks).toBe(0);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);
});
