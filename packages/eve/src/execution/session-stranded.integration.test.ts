import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import { createSession } from "#channel/session.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";
import { createSessionStreamResponse } from "#eve-channel/request.js";
import type { Runtime } from "#channel/types.js";
import {
  EVE_DEPLOYMENT_URL_ATTRIBUTE,
  EVE_SESSION_ATTRIBUTE,
  EVE_VERSION_ATTRIBUTE,
} from "#execution/eve-workflow-attributes.js";
import { signalSessionTimeoutStep } from "#execution/session/timeout-steps.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { handleSessionCallbackRequest } from "#subagents/callback-route.js";
import { readSessionEventStream, streamSessionEvents } from "#execution/session-event-stream.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";
import { encodeLine } from "#protocol/session-events/envelope.js";
import { emptySessionView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import {
  parkedAnchorWorkflow,
  sessionCommandInboxWorkflow,
} from "#internal/testing/session-inbox-workflow.js";
import { startSessionOwner, waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getRun, getWorld, start } from "#internal/workflow/runtime.js";
import { type SessionPredecessor } from "#protocol/session-events/families/session.js";
import { transcriptOf, type TranscriptData } from "#client/transcript.js";
import { sessions } from "#public/server/index.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineDynamic, defineInstructions } from "#public/definitions/instructions.js";
import { defineDynamic as defineDynamicModel } from "#public/definitions/model.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { defineTool } from "#tools/definition.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

/** eve version recorded by the owner an earlier build left parked on the local World. */
const PREVIOUS_EVE_VERSION = "0.0.1";

type ParkedRun = Awaited<ReturnType<typeof start>>;

/**
 * Parks a session owner the way an earlier eve build left it: its run records
 * that build's version, which the running build cannot replay.
 */
async function parkStrandedOwner(
  continuationToken: string,
  attributes: Readonly<Record<string, string>> = {},
): Promise<ParkedRun> {
  const run = await start(sessionCommandInboxWorkflow, [{ token: continuationToken }], {
    allowReservedAttributes: true,
    attributes: { ...attributes, [EVE_VERSION_ATTRIBUTE]: PREVIOUS_EVE_VERSION },
  });
  await waitForHook(run, { token: sessionInboxHookToken(continuationToken) });
  return run;
}

/**
 * Parks a session owner this eve version started on the Vercel deployment at
 * `deploymentUrl`, deleted afterwards: Vercel answers its URL with
 * `DEPLOYMENT_NOT_FOUND`. Each test names its own deployment, since ingress
 * remembers a deleted one for the life of the process.
 */
async function parkOwnerOnDeletedDeployment(
  continuationToken: string,
  deploymentUrl: string,
): Promise<ParkedRun> {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== `https://${deploymentUrl}/eve/v1/health` || init?.method !== "HEAD") {
      return await realFetch(input, init);
    }
    return new Response(null, {
      headers: { "x-vercel-error": "DEPLOYMENT_NOT_FOUND" },
      status: 404,
    });
  });
  const run = await start(sessionCommandInboxWorkflow, [{ token: continuationToken }], {
    allowReservedAttributes: true,
    attributes: {
      [EVE_DEPLOYMENT_URL_ATTRIBUTE]: deploymentUrl,
      [EVE_VERSION_ATTRIBUTE]: resolveInstalledPackageInfo().version,
    },
  });
  await waitForHook(run, { token: sessionInboxHookToken(continuationToken) });
  return run;
}

/** Parks a stranded handoff successor that owns the session of a separate anchor run. */
async function parkStrandedSuccessor(continuationToken: string) {
  const anchor = await start(parkedAnchorWorkflow, [{ token: `${continuationToken}:anchor` }]);
  await waitForHook(anchor, { token: `${continuationToken}:anchor` });
  const owner = await start(
    sessionCommandInboxWorkflow,
    [{ sessionId: anchor.runId, token: continuationToken }],
    {
      allowReservedAttributes: true,
      attributes: {
        [EVE_SESSION_ATTRIBUTE]: anchor.runId,
        [EVE_VERSION_ATTRIBUTE]: PREVIOUS_EVE_VERSION,
      },
    },
  );
  await waitForHook(owner, { token: sessionInboxHookToken(continuationToken) });
  return { anchor, owner };
}

async function listEventIds(runId: string): Promise<string[]> {
  const world = await getWorld();
  const events = await world.events.list({ runId, pagination: { limit: 1000 } });
  return events.data.map((event) => event.eventId);
}

async function cancelIfActive(...runs: readonly ParkedRun[]): Promise<void> {
  for (const run of runs) {
    const status = await run.status;
    if (status === "pending" || status === "running") await run.cancel();
  }
}

/** Reads a session's public stream until every expected user message has been received. */
async function waitForReceivedMessages(sessionId: string, expected: readonly string[]) {
  const reader = readSessionEventStream(sessionId).getReader();
  const pending = new Set(expected);
  try {
    while (pending.size > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === "delivery.consumed") {
        const text = value.data.parts.flatMap((part) => (part.kind === "text" ? [part.text] : []));
        for (const message of pending) {
          if (text.some((part) => part.includes(message))) pending.delete(message);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return [...pending];
}

/** The `session.started` event a session publishes before its first turn. */
async function readSessionStarted(sessionId: string) {
  const reader = readSessionEventStream(sessionId).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`Session "${sessionId}" ended before it started.`);
      if (value.type === "session.started") return value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Appends v26 events to a parked session's stream, one per line, as its earlier build recorded them. */
async function recordHistory(
  sessionId: string,
  events: readonly Record<string, unknown>[],
): Promise<void> {
  const writer = getRun(sessionId).getWritable<Uint8Array>().getWriter();
  try {
    for (const [index, event] of events.entries()) {
      const meta = { at: "2026-10-01T00:00:00.000Z", id: `evt_${String(index)}` };
      await writer.write(new TextEncoder().encode(`${JSON.stringify({ ...event, meta })}\n`));
    }
  } finally {
    writer.releaseLock();
  }
}

const TURN = { sequence: 0, turnId: "turn_0" };

/** A short conversation the stranded session recorded before the upgrade, in v26 events. */
const OFFSITE_HISTORY: readonly Record<string, unknown>[] = [
  { data: {}, type: "session.started" },
  {
    data: { ...TURN, message: "Alice asks for help planning the offsite." },
    type: "message.received",
  },
  {
    data: {
      ...TURN,
      finishReason: "stop",
      message: "Here is a draft agenda for the offsite.",
      stepIndex: 0,
    },
    type: "message.completed",
  },
];

/** A fresh session claims its address after `createSession` returns. */
async function waitForAliasOwner(runtime: Runtime, continuationToken: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const owner = await runtime.resolveContinuation(continuationToken);
    if (owner !== undefined) return owner.sessionId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`No session claimed "${continuationToken}".`);
}

function channelRuntime(): Runtime & { readonly createSession: ReturnType<typeof vi.fn> } {
  const runtime = createWorkflowRuntime({
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
  });
  return { ...runtime, createSession: vi.fn(runtime.createSession) };
}

function httpAddress(runtime: Runtime, continuationToken: string) {
  return createChannelAddress({
    adapter: { kind: "http" },
    channelName: "http",
    continuationToken,
    runtime,
  });
}

async function resetSession(runtime: Runtime, sessionId: string | undefined): Promise<void> {
  if (sessionId === undefined) return;
  await runtime.dispatchSession({
    command: { deliveryId: "reset-delivery", kind: "reset" },
    sessionId,
  });
  // Keep the World through shutdown without reading result data, which may already have expired.
  await vi.waitFor(async () => {
    expect(["completed", "cancelled", "failed"]).toContain(await getRun(sessionId).status);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stranded sessions", () => {
  it("refuses a session whose owner is pinned to a deleted deployment", async () => {
    const test = await createTestRuntime({ agent: { name: "stranded-deployment-by-id" } });
    await test.run(async () => {
      const stranded = await parkOwnerOnDeletedDeployment(
        "http:stranded-deployment-by-id",
        "agent-deleted-by-id.vercel.app",
      );
      const runtime = channelRuntime();
      try {
        const eventsBefore = await listEventIds(stranded.runId);

        const refusal = await createSession(stranded.runId, runtime)
          .send("Alice follows up after the redeploy.", { auth: null })
          .catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(SessionStrandedError);
        expect(refusal).toMatchObject({
          owner: { eveVersion: resolveInstalledPackageInfo().version },
        });
        const response = await createSessionStreamResponse(
          new Request(`https://eve.test/eve/v1/session/${stranded.runId}/stream`),
          createSession(stranded.runId, runtime),
        );
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ code: "session_stranded" });
        await expect(listEventIds(stranded.runId)).resolves.toEqual(eventsBefore);
        await expect(stranded.status).resolves.toBe("running");
      } finally {
        await cancelIfActive(stranded);
      }
    });
  });

  it("runs the replacement as the message's author and queues another author behind it", async () => {
    const {
      runtime: test,
      seen,
      whoami,
    } = await callerRecordingRuntime("stranded-deployment-callers");
    await test.run(async () => {
      const continuationToken = "http:stranded-deployment-callers";
      const stranded = await parkOwnerOnDeletedDeployment(
        continuationToken,
        "agent-deleted-callers.vercel.app",
      );
      const runtime = channelRuntime();
      const address = httpAddress(runtime, "stranded-deployment-callers");
      let freshSessionId: string | undefined;
      try {
        const fresh = await address.send("Alice asks whoami after the redeploy.", {
          auth: ALICE,
        });
        freshSessionId = fresh.sessionId;
        expect(fresh.sessionId).not.toBe(stranded.runId);
        await expect(stranded.status).resolves.toBe("cancelled");

        // Alice's turn is inside her tool call, so Bob arrives mid-turn.
        await whoami.entered;
        const bobs = await address.send("Bob asks whoami right behind her.", { auth: BOB });
        expect(bobs.sessionId).toBe(fresh.sessionId);

        // Bob's message was accepted, yet turn_0 is still open inside Alice's call and has
        // consumed only her message: his waits for the turn to end.
        const open = await readSessionEvents(
          fresh.sessionId,
          (event) => event.type === "call.started",
        );
        expect(open.map((event) => event.type)).not.toContain("turn.settled");
        expect(turnsOf(open)).toEqual([{ messages: [ALICE_ASKS], turnId: "turn_0" }]);
        expect(seen).toEqual([{ caller: "alice", turnId: "turn_0" }]);

        whoami.release();
        const settled = await readSessionEvents(fresh.sessionId, settledTurns(2));
        // Bob's delivery enters the session only after turn_0 settles, as its own turn and author.
        const order = settled.flatMap((event) =>
          event.type === "turn.settled"
            ? [`settled:${event.data.turnId}`]
            : event.type === "delivery.admitted"
              ? [`admitted:${event.data.principal?.id}`]
              : [],
        );
        expect(order).toEqual([
          "admitted:alice",
          "settled:turn_0",
          "admitted:bob",
          "settled:turn_1",
        ]);
        expect(turnsOf(settled)).toEqual([
          { messages: [ALICE_ASKS], turnId: "turn_0" },
          { messages: ["Bob asks whoami right behind her."], turnId: "turn_1" },
        ]);
        expect(seen).toEqual([
          { caller: "alice", turnId: "turn_0" },
          { caller: "bob", turnId: "turn_1" },
        ]);
      } finally {
        whoami.release();
        await cancelIfActive(stranded);
        await resetSession(runtime, freshSessionId);
      }
    });
  });

  it("ends a stranded session on a channel delivery and starts a fresh one", async () => {
    const test = await createTestRuntime({ agent: { name: "stranded-session-alias" } });
    await test.run(async () => {
      const logs = captureLogRecords();
      const continuationToken = "http:stranded-session-alias";
      const { anchor, owner } = await parkStrandedSuccessor(continuationToken);
      const runtime = channelRuntime();
      let freshSessionId: string | undefined;
      const reader = readSessionEventStream(anchor.runId).getReader();
      try {
        const waiting = reader.read();
        const fresh = await httpAddress(runtime, "stranded-session-alias").send(
          "Alice asks for the weekly summary after the upgrade.",
          { auth: null },
        );
        freshSessionId = fresh.sessionId;

        await expect(waiting).resolves.toMatchObject({
          done: false,
          value: {
            type: "session.ended",
            data: {
              cause: { policy: "stranded-message" },
              error: { code: "session_stranded", message: "This session is no longer available." },
              outcome: "failed",
            },
          },
        });
        await expect(reader.read()).resolves.toMatchObject({ done: true });
        expect(fresh.sessionId).not.toBe(anchor.runId);
        // The runtime started the successor itself; the channel started nothing.
        expect(runtime.createSession).not.toHaveBeenCalled();
        await expect(owner.status).resolves.toBe("cancelled");
        await expect(anchor.status).resolves.toBe("cancelled");
        await waitForHook(
          { runId: fresh.sessionId },
          { token: sessionInboxHookToken(continuationToken) },
        );
        await expect(runtime.resolveContinuation(continuationToken)).resolves.toEqual({
          sessionId: fresh.sessionId,
        });
        await expect(
          waitForReceivedMessages(fresh.sessionId, ["Alice asks for the weekly summary"]),
        ).resolves.toEqual([]);
        // The successor names the session it replaced.
        const started = await readSessionStarted(fresh.sessionId);
        expect(started.data.predecessor).toEqual({ sessionId: anchor.runId });
        // A remote job can finish after replacement. Its fixed parent inbox
        // must not route the result into the new conversation.
        const callback = await handleSessionCallbackRequest(
          new Request("https://eve.test/callback", {
            method: "POST",
            body: JSON.stringify({
              kind: "turn.completed",
              callId: "old-call",
              subagentName: "research",
              outcome: {
                kind: "parked",
                result: { kind: "succeeded", output: "Alice's report" },
                usageDelta: {
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                },
              },
              output: "Alice's report",
            }),
          }),
          {
            params: { token: sessionInboxHookToken(sessionCommandHookToken(anchor.runId)) },
            requestIp: null,
            waitUntil() {},
          },
        );
        expect(callback.status).toBe(404);
        await expect(runtime.resolveContinuation(continuationToken)).resolves.toEqual({
          sessionId: fresh.sessionId,
        });

        const resets = logs.records.filter((record) => record.message === "Reset stranded session");
        expect(resets).toEqual([
          expect.objectContaining({
            fields: {
              currentEveVersion: resolveInstalledPackageInfo().version,
              previousEveVersion: PREVIOUS_EVE_VERSION,
              previousSessionId: anchor.runId,
              trigger: "message",
            },
            level: "warn",
          }),
        ]);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        await cancelIfActive(owner, anchor);
        await resetSession(runtime, freshSessionId);
      }
    });
  });

  it("ends a stranded session on a context-only channel delivery", async () => {
    const test = await createTestRuntime({ agent: { name: "stranded-session-context" } });
    await test.run(async () => {
      const continuationToken = "http:stranded-session-context";
      const stranded = await parkStrandedOwner(continuationToken);
      const runtime = channelRuntime();
      let freshSessionId: string | undefined;
      try {
        const fresh = await httpAddress(runtime, "stranded-session-context").deliver(
          { context: ["Alice moved the standup to Thursday."] },
          { auth: null },
        );
        freshSessionId = fresh.sessionId;

        expect(fresh.sessionId).not.toBe(stranded.runId);
        await expect(stranded.status).resolves.toBe("cancelled");
        await expect(waitForAliasOwner(runtime, continuationToken)).resolves.toBe(fresh.sessionId);
      } finally {
        await cancelIfActive(stranded);
        await resetSession(runtime, freshSessionId);
      }
    });
  });

  it("starts one fresh session for concurrent deliveries to a stranded session", async () => {
    const test = await createTestRuntime({ agent: { name: "stranded-session-concurrent" } });
    await test.run(async () => {
      const continuationToken = "http:stranded-session-concurrent";
      const stranded = await parkStrandedOwner(continuationToken);
      const runtime = channelRuntime();
      const address = httpAddress(runtime, "stranded-session-concurrent");
      let freshSessionId: string | undefined;
      try {
        const candidates = await Promise.all([
          address.send("Alice shares the release notes.", { auth: null }),
          address.send("Bob shares the rollout plan.", { auth: null }),
        ]);
        freshSessionId = await waitForAliasOwner(runtime, continuationToken);

        expect(candidates.map((session) => session.sessionId)).toContain(freshSessionId);
        expect(freshSessionId).not.toBe(stranded.runId);
        await expect(stranded.status).resolves.toBe("cancelled");
        await expect(
          waitForReceivedMessages(freshSessionId!, [
            "Alice shares the release notes.",
            "Bob shares the rollout plan.",
          ]),
        ).resolves.toEqual([]);
      } finally {
        await cancelIfActive(stranded);
        await resetSession(runtime, freshSessionId);
      }
    });
  });

  it("refuses a send by session id without writing to the stranded run", async () => {
    const test = await createTestRuntime({ agent: { name: "stranded-session-by-id" } });
    await test.run(async () => {
      const stranded = await parkStrandedOwner("http:stranded-session-by-id");
      const runtime = channelRuntime();
      try {
        const eventsBefore = await listEventIds(stranded.runId);

        const refusal = await createSession(stranded.runId, runtime)
          .send("Alice follows up after the upgrade.", { auth: null })
          .catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(SessionStrandedError);
        expect(refusal).toMatchObject({ owner: { eveVersion: PREVIOUS_EVE_VERSION } });
        expect((refusal as Error).message).not.toContain(stranded.runId);
        const response = await createSessionStreamResponse(
          new Request(`https://eve.test/eve/v1/session/${stranded.runId}/stream`),
          createSession(stranded.runId, runtime),
        );
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ code: "session_stranded" });
        // Recorded history stays readable without resetting the session first.
        const history = await createSessionStreamResponse(
          new Request(`https://eve.test/eve/v1/session/${stranded.runId}/stream?follow=false`),
          createSession(stranded.runId, runtime),
        );
        expect(history.status).toBe(200);
        expect(history.headers.get("x-eve-stream-tail-index")).not.toBeNull();
        await expect(history.text()).resolves.toBeTypeOf("string");
        expect(runtime.createSession).not.toHaveBeenCalled();
        await expect(stranded.status).resolves.toBe("running");
        await expect(listEventIds(stranded.runId)).resolves.toEqual(eventsBefore);
      } finally {
        await cancelIfActive(stranded);
      }
    });
  });

  it("ends a stranded session on an explicit reset and refuses to clear it", async () => {
    const test = await createTestRuntime({ agent: { name: "stranded-session-reset" } });
    await test.run(async () => {
      const continuationToken = "http:stranded-session-reset";
      const stranded = await parkStrandedOwner(continuationToken);
      const runtime = channelRuntime();
      try {
        // Clear keeps the session, which cannot run, so the caller must choose reset.
        await expect(
          runtime.dispatchSession({
            command: { deliveryId: "clear-delivery", kind: "clear" },
            sessionId: stranded.runId,
          }),
        ).rejects.toBeInstanceOf(SessionStrandedError);
        await expect(stranded.status).resolves.toBe("running");

        const reader = readSessionEventStream(stranded.runId).getReader();
        const admitted = reader.read();
        await expect(
          runtime.dispatchSession({
            command: { deliveryId: "reset-delivery", kind: "reset" },
            sessionId: stranded.runId,
          }),
        ).resolves.toEqual({ previousSessionId: stranded.runId, status: "reset" });
        await expect(admitted).resolves.toMatchObject({
          value: {
            type: "delivery.admitted",
            data: { deliveryId: "reset-delivery", source: { control: "reset" } },
          },
        });
        await expect(reader.read()).resolves.toMatchObject({
          value: {
            type: "delivery.settled",
            data: { deliveryId: "reset-delivery", outcome: "applied" },
          },
        });
        await expect(reader.read()).resolves.toMatchObject({
          value: {
            type: "session.ended",
            data: { cause: { deliveryId: "reset-delivery" } },
          },
        });
        await reader.cancel();
        await expect(stranded.status).resolves.toBe("cancelled");
        await expect(runtime.resolveContinuation(continuationToken)).resolves.toBeUndefined();
      } finally {
        await cancelIfActive(stranded);
      }
    });
  });

  it("fails a reset before cancelling when the history read stalls", async () => {
    const test = await createTestRuntime({ agent: { name: "stranded-session-stalled-read" } });
    await test.run(async () => {
      const continuationToken = "http:stranded-session-stalled-read";
      const stranded = await parkStrandedOwner(continuationToken);
      const runtime = channelRuntime();
      const world = await getWorld();
      const getInfo = world.streams.getInfo.bind(world.streams);
      let stalled!: () => void;
      const reached = new Promise<void>((resolve) => (stalled = resolve));
      const stall = vi.spyOn(world.streams, "getInfo").mockImplementation((runId, name) => {
        if (runId !== stranded.runId) return getInfo(runId, name);
        stalled();
        return new Promise(() => {});
      });
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
      try {
        const reset = runtime.dispatchSession({
          command: { deliveryId: "reset-delivery", kind: "reset" },
          sessionId: stranded.runId,
        });
        const outcome = expect(reset).rejects.toThrow(
          `Timed out reading the history of stranded session "${stranded.runId}". Nothing was ended; retry the request.`,
        );
        await reached;
        await vi.advanceTimersByTimeAsync(30_000);
        await outcome;
        vi.useRealTimers();
        stall.mockRestore();

        await expect(stranded.status).resolves.toBe("running");
        const types: string[] = [];
        for await (const event of streamSessionEvents(stranded.runId, { follow: false })) {
          types.push(event.type);
        }
        expect(types).not.toContain("session.ended");

        await expect(resetSession(runtime, stranded.runId)).resolves.toBeUndefined();
        await expect(stranded.status).resolves.toBe("cancelled");
      } finally {
        vi.useRealTimers();
        stall.mockRestore();
        await cancelIfActive(stranded);
      }
    });
  });

  it("closes the turn and interaction a reset leaves open before the session ends", async () => {
    const test = await createTestRuntime({ agent: { name: "stranded-session-cascade" } });
    await test.run(async () => {
      const stranded = await parkStrandedOwner("http:stranded-session-cascade");
      const runtime = channelRuntime();
      try {
        const waiting: SessionEvent[] = [
          { data: { deliveryId: "d0" }, type: "delivery.admitted" },
          {
            data: { cause: { deliveryId: "d0" }, follows: null, turnId: "turn_0" },
            scope: { turnId: "turn_0" },
            type: "turn.started",
          },
          {
            data: {
              interactionId: "question-1",
              request: { kind: "question", prompt: "Which room should Alice book?" },
              subject: { turnId: "turn_0" },
            },
            scope: { turnId: "turn_0" },
            type: "interaction.opened",
          },
        ];
        const writer = getRun(stranded.runId).getWritable<Uint8Array>().getWriter();
        await writer.write(
          new TextEncoder().encode(encodeLine({ at: "2026-10-01T00:00:00.000Z", facts: waiting })),
        );
        writer.releaseLock();

        await resetSession(runtime, stranded.runId);

        const view = emptySessionView();
        const types: string[] = [];
        for await (const event of streamSessionEvents(stranded.runId, { follow: false })) {
          foldReceivedEvent(view, event);
          types.push(event.type);
        }
        expect(types.at(-1)).toBe("session.ended");
        expect(view.session.status).toBe("ended");
        expect(view.turns.turn_0).toMatchObject({ outcome: "cancelled", status: "settled" });
        expect(view.interactions["question-1"]?.status).not.toBe("open");
      } finally {
        await cancelIfActive(stranded);
      }
    });
  });

  it("refuses create() at a stranded address until it is reset", async () => {
    const test = await createTestRuntime({ agent: { name: "stranded-session-create" } });
    await test.run(async () => {
      const continuationToken = "stranded-session-create";
      const stranded = await parkStrandedOwner(`http:${continuationToken}`);
      const runtime = channelRuntime();
      const address = httpAddress(runtime, continuationToken);
      const history = [{ role: "user" as const, text: "Alice asks for the venue list." }];
      let createdSessionId: string | undefined;
      try {
        // A stranded owner cannot run, so `created: false` would hand back a dead session.
        await expect(address.create({ auth: null, history })).rejects.toThrow(
          "Call reset() on the address, then create() again",
        );
        expect(runtime.createSession).not.toHaveBeenCalled();
        await expect(stranded.status).resolves.toBe("running");

        await address.reset();
        const result = await address.create({ auth: null, history });
        createdSessionId = result.session.id;
        expect(result.created).toBe(true);
      } finally {
        await resetSession(runtime, createdSessionId);
        await cancelIfActive(stranded);
      }
    });
  });

  it("keeps a stranded session when a channel delivery also carries input responses", async () => {
    const test = await createTestRuntime({ agent: { name: "stranded-session-responses" } });
    await test.run(async () => {
      const continuationToken = "http:stranded-session-responses";
      const stranded = await parkStrandedOwner(continuationToken);
      const runtime = channelRuntime();
      try {
        const refusal = await httpAddress(runtime, "stranded-session-responses")
          .deliver(
            {
              answers: [{ optionId: "approve", interactionId: "request_1" }],
              message: "Alice approves the deploy and adds a note.",
            },
            { auth: null },
          )
          .catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(SessionStrandedError);
        expect((refusal as Error).message).toContain("pending requests can no longer be answered");
        expect(runtime.createSession).not.toHaveBeenCalled();
        await expect(stranded.status).resolves.toBe("running");
      } finally {
        await cancelIfActive(stranded);
      }
    });
  });

  it("delivers to a session owned by the running eve version", async () => {
    const test = await createTestRuntime({ agent: { name: "stranded-session-runnable" } });
    await test.run(async () => {
      const continuationToken = "http:stranded-session-runnable";
      const owner = await startSessionOwner(sessionCommandInboxWorkflow, [
        { token: continuationToken },
      ]);
      await waitForHook(owner, { token: sessionInboxHookToken(continuationToken) });
      const runtime = channelRuntime();
      try {
        const session = await httpAddress(runtime, "stranded-session-runnable").send(
          "Bob checks in on the deploy.",
          { auth: null },
        );

        expect(session.sessionId).toBe(owner.runId);
        expect(runtime.createSession).not.toHaveBeenCalled();
        await expect(owner.status).resolves.toBe("running");
      } finally {
        await cancelIfActive(owner);
      }
    });
  });

  it("ends a retired session when its session timeout elapses", async () => {
    const test = await createTestRuntime({ agent: { name: "stranded-session-timeout" } });
    await test.run(async () => {
      const logs = captureLogRecords();
      const continuationToken = "http:stranded-session-timeout";
      const stranded = await parkStrandedOwner(continuationToken);
      const runtime = channelRuntime();
      try {
        await signalSessionTimeoutStep({
          ownerRunId: stranded.runId,
          token: sessionCommandHookToken(stranded.runId),
        });

        await expect(stranded.status).resolves.toBe("cancelled");
        await expect(runtime.resolveContinuation(continuationToken)).resolves.toBeUndefined();
        expect(runtime.createSession).not.toHaveBeenCalled();
        expect(logs.records).toContainEqual(
          expect.objectContaining({
            fields: expect.objectContaining({ trigger: "timeout" }),
            message: "Reset stranded session",
          }),
        );
      } finally {
        await cancelIfActive(stranded);
      }
    });
  });

  it("lets a session.started instruction read the replaced conversation", async () => {
    const { reads, test } = await transcriptReadingRuntime("stranded-session-transcript");
    await test.run(async () => {
      const stranded = await parkStrandedOwner("http:stranded-session-transcript");
      await recordHistory(stranded.runId, OFFSITE_HISTORY);
      const runtime = channelRuntime();
      let freshSessionId: string | undefined;
      try {
        const fresh = await httpAddress(runtime, "stranded-session-transcript").send(
          "Alice asks to move the offsite to Friday.",
          { auth: null },
        );
        freshSessionId = fresh.sessionId;

        await expect(reads.wait()).resolves.toEqual([
          {
            messages: [
              { role: "user", text: "Alice asks for help planning the offsite." },
              { role: "assistant", text: "Here is a draft agenda for the offsite." },
            ],
            predecessor: { sessionId: stranded.runId },
          },
        ]);
      } finally {
        await cancelIfActive(stranded);
        await resetSession(runtime, freshSessionId);
      }
    });
  });
});

function testUser(principalId: string) {
  return {
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId,
    principalType: "user" as const,
  };
}
const ALICE = testUser("alice");
const BOB = testUser("bob");

/** Calls `whoami` once per turn, then replies. */
const whoamiModel = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ prompt }) =>
      prompt.at(-1)?.role === "tool"
        ? textStreamResult("Done.")
        : toolCallStreamResult({ input: "{}", toolCallId: "call-whoami", toolName: "whoami" }),
    modelId: "whoami-model",
    provider: "eve-test",
  }),
);

const ALICE_ASKS = "Alice asks whoami after the redeploy.";

/**
 * An app whose only tool records the turn's caller. The first call signals
 * `whoami.entered` and blocks until `whoami.release()`, so a test can act
 * while that turn is provably still running; later calls pass straight through.
 */
async function callerRecordingRuntime(name: string) {
  const seen: Array<{ readonly caller: string | null; readonly turnId: string }> = [];
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamicModel(() => ({
          model: whoamiModel,
          modelContextWindowTokens: 200_000,
        })),
      }),
      name,
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineTool({
            description: "Report who is asking.",
            execute: async (_input, ctx) => {
              seen.push({
                caller: ctx.session.auth.current?.principalId ?? null,
                turnId: ctx.session.turn.id,
              });
              entered.resolve();
              await released.promise;
              return { ok: true };
            },
            inputSchema: {},
          }),
        }),
        logicalPath: "tools/whoami.ts",
      },
    ],
  });
  return {
    runtime,
    seen,
    whoami: { entered: entered.promise, release: () => released.resolve() },
  };
}

/** The session's events from the start up to and including the first one `stop` accepts. */
async function readSessionEvents(sessionId: string, stop: (event: SessionStreamEvent) => boolean) {
  const reader = readSessionEventStream(sessionId).getReader();
  const events: SessionStreamEvent[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`Session "${sessionId}" ended after ${events.length} events.`);
      events.push(value);
      if (stop(value)) return events;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Stops once `count` turns have settled. */
function settledTurns(count: number) {
  let settled = 0;
  return (event: SessionStreamEvent) => event.type === "turn.settled" && ++settled === count;
}

/** The turns the events opened, in order, each with the user messages it consumed. */
function turnsOf(events: readonly SessionStreamEvent[]) {
  const turns: Array<{ messages: string[]; turnId: string }> = [];
  for (const event of events) {
    if (event.type === "turn.started") turns.push({ messages: [], turnId: event.data.turnId });
    if (event.type === "delivery.consumed") {
      const turn = turns.find((candidate) => candidate.turnId === event.data.turnId);
      const text = event.data.parts.flatMap((part) => (part.kind === "text" ? [part.text] : []));
      turn?.messages.push(...text);
    }
  }
  return turns;
}

type TranscriptRead = TranscriptData & { readonly predecessor: SessionPredecessor };

/**
 * An app whose `session.started` instruction reads the replaced session's
 * conversation the way the predecessor docs show.
 */
async function transcriptReadingRuntime(name: string) {
  const recorded: TranscriptRead[] = [];
  const test = await createTestRuntime({
    agent: { name },
    modules: [
      {
        logicalPath: "instructions/replaced-conversation.ts",
        loadNamespace: async () => ({
          default: defineDynamic(async (ctx) => {
            const predecessor = ctx.session.predecessor;
            if (predecessor === undefined) return null;
            // The predecessor's transcript is read once, and joins the conversation once.
            const messages = await ctx.memo(predecessor.sessionId, async () => {
              const events = [];
              for await (const event of sessions.attach(predecessor.sessionId).stream({
                follow: false,
                startIndex: -2000,
              })) {
                events.push(event);
              }
              const transcript = transcriptOf(events, { maxMessages: 40 });
              recorded.push({ ...transcript, predecessor });
              return transcript.messages.map((message) => JSON.stringify(message));
            });
            return messages.length === 0
              ? null
              : defineInstructions({ content: messages.join("\n"), role: "user" });
          }),
        }),
      },
    ],
  });
  const reads = {
    async wait(): Promise<readonly TranscriptRead[]> {
      await vi.waitFor(() => expect(recorded).not.toHaveLength(0), { timeout: 30_000 });
      return recorded;
    },
  };
  return { reads, test };
}
