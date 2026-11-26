import { MockLanguageModelV4 } from "ai/test";
import { commitOf } from "#harness/session-machine/commit.js";
import { expect, it, onTestFinished, vi } from "vitest";
import { ContextContainer } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { defineDynamic } from "#dynamic/definition.js";
import {
  readInterruptedAttempt,
  recoverInterruptedStep,
} from "#execution/session/interrupted-step.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import type { HarnessSession } from "#harness/types.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext, captureEvents } from "#internal/testing/entry-test-helpers.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { startTestSession } from "#internal/testing/test-session-hosts.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";
import { defineAgent } from "#public/definitions/agent.js";
import { withOpenTurn, withPublished } from "#internal/testing/session-machine.js";

it.each([
  { outcome: "completed" as const, isError: false },
  { outcome: "failed" as const, isError: true },
])(
  "adopts a recorded $outcome session ending without restoring providers",
  async ({ outcome, isError }) => {
    const session: HarnessSession = {
      compaction: {},
      continuationToken: "test",
      history: [],
      sessionId: "ended-session",
    };
    const started = { type: "session.started" as const, data: {} };
    const ended = { type: "session.ended" as const, data: { outcome } };
    const recorded = withPublished(withPublished(session, [started]), [ended]);
    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, session.sessionId);
    enterSessionProjection(ctx, recorded.state);
    const publish = vi.fn(async () => session);
    const at = "2026-10-21T00:00:00.000Z";
    const result = await recoverInterruptedStep({
      admission: commitOf([]),
      attempt: readInterruptedAttempt(0, [
        { position: 0, line: { at, facts: [started] } },
        { position: 1, line: { at, facts: [ended] } },
      ]),
      ctx,
      publish,
      session,
      stepInput: undefined,
    });
    expect(result).toMatchObject({ result: { action: "done", isError, output: "" } });
    expect(publish).not.toHaveBeenCalled();
  },
);

function openTurnSession(sessionId: string) {
  const session: HarnessSession = {
    compaction: {},
    continuationToken: "test",
    history: [],
    sessionId,
  };
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, sessionId);
  return { ctx, session: withOpenTurn(session, { sequence: 1, turnId: "turn-1" }) };
}

it("fails the turn with a fixed failure, never what a step's last attempt threw", async () => {
  const { ctx, session } = openTurnSession("exhausted-session");
  enterSessionProjection(ctx, session.state);
  const published: SessionEvent[] = [];
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => logged.mockRestore());
  const result = await recoverInterruptedStep({
    admission: commitOf([]),
    attempt: readInterruptedAttempt(0, []),
    ctx,
    failed: { error: new TypeError("bad row: Alice's account number is 4242") },
    publish: async (events, current) => {
      published.push(...[events].flat());
      return current;
    },
    session,
    stepInput: undefined,
  });
  const message = "This turn failed before it finished. Send another message to continue.";
  const settled = published.find((event) => event.type === "turn.settled");
  expect(settled?.data).toMatchObject({
    error: { code: "TURN_FAILED", id: expect.any(String), message },
    outcome: "failed",
  });
  expect(JSON.stringify(published)).not.toContain("4242");
  expect(result).toMatchObject({ result: { settled: { isError: true, output: message } } });
  const errorId = (settled!.data as { readonly error: { readonly id: string } }).error.id;
  expect(JSON.stringify(logged.mock.calls)).toContain(errorId);
  expect(JSON.stringify(logged.mock.calls)).toContain("TypeError");
  expect(JSON.stringify(logged.mock.calls)).not.toContain("4242");
});

it("leaves a turn stopped while its step kept failing open for its cancel", async () => {
  const { ctx, session } = openTurnSession("stopped-session");
  enterSessionProjection(ctx, session.state);
  const published: SessionEvent[] = [];
  const stepInput = { message: "Please look up Alice's plan." };
  const result = await recoverInterruptedStep({
    admission: commitOf([]),
    attempt: readInterruptedAttempt(0, []),
    ctx,
    failed: { error: new TypeError("bad row: 4242"), stopped: true },
    publish: async (events, current) => {
      published.push(...[events].flat());
      return current;
    },
    session,
    stepInput,
  });
  expect(result).toMatchObject({ stepInput });
  expect(published.filter((event) => event.type === "turn.settled")).toEqual([]);
});

it("keeps the outcome of a turn an attempt settled when every attempt failed", async () => {
  const { ctx, session } = openTurnSession("settled-session");
  const settled = {
    type: "turn.settled" as const,
    data: { outcome: "completed" as const, turnId: "turn-1" },
  };
  const recorded = withPublished(session, [settled]);
  enterSessionProjection(ctx, recorded.state);
  const publish = vi.fn(async () => session);
  const result = await recoverInterruptedStep({
    admission: commitOf([]),
    attempt: readInterruptedAttempt(0, [
      { position: 0, line: { at: "2026-10-21T00:00:00.000Z", facts: [settled] } },
    ]),
    ctx,
    failed: { error: new Error("The session stream is unavailable") },
    publish,
    session,
    stepInput: undefined,
  });
  expect(result).toMatchObject({ result: { action: "parked", settled: { isError: false } } });
  expect(publish).not.toHaveBeenCalled();
});

it("keeps a settled turn's imported history ahead of its message and reply", async () => {
  const { ctx, session } = openTurnSession("imported-session");
  const settled = {
    type: "turn.settled" as const,
    data: { outcome: "completed" as const, reply: ["p"], turnId: "turn-1" },
  };
  enterSessionProjection(ctx, withPublished(session, [settled]).state);
  const reply = {
    type: "content.completed",
    data: { kind: "text", partId: "p", value: "Hi Bob." },
  };
  const result = await recoverInterruptedStep({
    admission: commitOf([]),
    attempt: readInterruptedAttempt(0, [
      { position: 0, line: { at: "2026-10-21T00:00:00.000Z", facts: [reply, settled] } },
    ]),
    ctx,
    publish: vi.fn(async () => session),
    session,
    stepInput: {
      history: [
        { role: "user", text: "Bob asked about the launch." },
        { role: "assistant", text: "It ships Friday." },
      ],
      message: "Thanks, Alice here.",
    },
  });
  expect("result" in result && result.result.history).toEqual([
    {
      content: "Bob asked about the launch.",
      kind: "user",
      metadata: { "eve.imported": true },
      role: "user",
    },
    { content: "It ships Friday.", role: "assistant" },
    expect.objectContaining({ content: "Thanks, Alice here.", role: "user" }),
    { content: "Hi Bob.", role: "assistant" },
  ]);
});

it("does not duplicate folded pendingDispatch events when a turnStep fails and recovers", async () => {
  let parentCalls = 0;
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const users = prompt
          .filter((message) => message.role === "user")
          .map((message) => JSON.stringify(message.content))
          .join("\n");
        if (users.includes("CHILD_WORK")) {
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ id: "t", type: "text-start" });
                controller.enqueue({ delta: "child ok", id: "t", type: "text-delta" });
                controller.enqueue({ id: "t", type: "text-end" });
                controller.enqueue({
                  finishReason: { raw: "stop", unified: "stop" },
                  type: "finish",
                  usage: {
                    inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
                    outputTokens: { reasoning: 0, text: 1, total: 1 },
                  },
                });
                controller.close();
              },
            }),
          };
        }
        parentCalls += 1;
        if (parentCalls === 1) {
          return toolCallStreamResult({
            input: JSON.stringify({ message: "CHILD_WORK" }),
            toolCallId: "call_agent_1",
            toolName: "agent",
          });
        }
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ id: "p", type: "text-start" });
              controller.enqueue({ delta: "never reached", id: "p", type: "text-delta" });
              controller.enqueue({ id: "p", type: "text-end" });
              controller.enqueue({
                finishReason: { raw: "stop", unified: "stop" },
                type: "finish",
                usage: {
                  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
                  outputTokens: { reasoning: 0, text: 1, total: 1 },
                },
              });
              controller.close();
            },
          }),
        };
      },
      modelId: "scripted",
      provider: "eve-test",
    }),
  );

  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name: "folded-dispatch-recovery",
    },
  });

  let parentSessionId: string | undefined;
  let failedOnce = false;
  const decoder = new TextDecoder();
  await runtime.run(async () => {
    const run = await startTestSession(
      "in-process",
      {
        input: { message: "Start a subagent." },
        kind: "initial",
        ownerDeploymentId: "dpl_test",
        serializedContext: buildSerializedContext({
          channelKind: "http",
          continuationToken: "http:folded-dispatch-recovery",
        }),
      },
      {
        stepFaults: {
          maxRetries: 0,
          failWrite(step, chunk) {
            if (step.name !== "turnStep") return false;
            const text = decoder.decode(chunk);
            if (text.includes('"type":"task.started"')) {
              parentSessionId = step.sessionId;
              return false;
            }
            if (
              parentSessionId !== undefined &&
              step.sessionId === parentSessionId &&
              !failedOnce &&
              text.includes('"type":"model.started"')
            ) {
              failedOnce = true;
              return true;
            }
            return false;
          },
        },
      },
    );
    const stream = captureEvents(run);
    try {
      const events = await stream.nextUntil(
        "failed parent turn",
        (event: SessionStreamEvent) => event.type === "turn.settled",
      );
      expect(failedOnce).toBe(true);
      expect(filterEventsByType(events, "task.started")).toHaveLength(1);
      expect(filterEventsByType(events, "turn.settled").map((e) => e.data.outcome)).toEqual([
        "failed",
      ]);
    } finally {
      stream.dispose();
      await run.cancel();
    }
  });
});
