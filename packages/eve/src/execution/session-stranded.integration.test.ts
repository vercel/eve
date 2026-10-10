import { describe, expect, it, vi } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import { createSession } from "#channel/session.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";
import { createSessionStreamResponse } from "#eve-channel/request.js";
import type { Runtime } from "#channel/types.js";
import {
  EVE_SESSION_ATTRIBUTE,
  EVE_VERSION_ATTRIBUTE,
} from "#execution/eve-workflow-attributes.js";
import { signalSessionTimeoutStep } from "#execution/session/timeout-steps.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { handleSessionCallbackRequest } from "#subagents/callback-route.js";
import { readSessionEventStream } from "#execution/session-event-stream.js";
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
import { type SessionPredecessor } from "#protocol/message.js";
import { transcriptReducer, type TranscriptData } from "#client/transcript-reducer.js";
import { sessions } from "#public/server/index.js";
import { defineDynamic, defineInstructions } from "#public/definitions/instructions.js";
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
  await runtime.dispatchSession({ command: { kind: "reset" }, sessionId });
}

describe("stranded sessions", () => {
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
        freshSessionId = fresh.id;

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
        expect(fresh.id).not.toBe(anchor.runId);
        // The runtime started the successor itself; the channel started nothing.
        expect(runtime.createSession).not.toHaveBeenCalled();
        await expect(owner.status).resolves.toBe("cancelled");
        await expect(anchor.status).resolves.toBe("cancelled");
        await waitForHook({ runId: fresh.id }, { token: sessionInboxHookToken(continuationToken) });
        await expect(runtime.resolveContinuation(continuationToken)).resolves.toEqual({
          sessionId: fresh.id,
        });
        await expect(
          waitForReceivedMessages(fresh.id, ["Alice asks for the weekly summary"]),
        ).resolves.toEqual([]);
        // The successor names the session it replaced.
        const started = await readSessionStarted(fresh.id);
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
          sessionId: fresh.id,
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
        freshSessionId = fresh.id;

        expect(fresh.id).not.toBe(stranded.runId);
        await expect(stranded.status).resolves.toBe("cancelled");
        await expect(waitForAliasOwner(runtime, continuationToken)).resolves.toBe(fresh.id);
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

        expect(candidates.map((session) => session.id)).toContain(freshSessionId);
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
          runtime.dispatchSession({ command: { kind: "clear" }, sessionId: stranded.runId }),
        ).rejects.toBeInstanceOf(SessionStrandedError);
        await expect(stranded.status).resolves.toBe("running");

        await expect(
          runtime.dispatchSession({ command: { kind: "reset" }, sessionId: stranded.runId }),
        ).resolves.toEqual({ previousSessionId: stranded.runId, status: "reset" });
        await expect(stranded.status).resolves.toBe("cancelled");
        await expect(runtime.resolveContinuation(continuationToken)).resolves.toBeUndefined();
      } finally {
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
              inputResponses: [{ optionId: "approve", requestId: "request_1" }],
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

        expect(session.id).toBe(owner.runId);
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
        freshSessionId = fresh.id;

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
          default: defineDynamic({
            events: {
              "session.started": async (_event, ctx) => {
                const predecessor = ctx.session.predecessor;
                if (predecessor === undefined) return null;
                const reducer = transcriptReducer({ maxMessages: 40 });
                let transcript = reducer.initial();
                for await (const event of sessions.attach(predecessor.sessionId).stream({
                  follow: false,
                  startIndex: -2000,
                })) {
                  transcript = reducer.reduce(transcript, event);
                }
                recorded.push({ ...transcript, predecessor });
                return transcript.messages.length === 0
                  ? null
                  : defineInstructions({
                      content: transcript.messages
                        .map((message) => JSON.stringify(message))
                        .join("\n"),
                      role: "user",
                    });
              },
            },
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
