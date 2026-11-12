import { jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStreamWriteError } from "#harness/session-stream-write-error.js";
import type { HarnessSession } from "#harness/types.js";
import type { SessionInstrumentation } from "#instrumentation/runtime.js";
import { createTestKernel } from "#internal/testing/kernel.js";
import { eachEvent } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";

// Once a session stream write fails, the stream is errored and every later write fails too. The
// step rethrows the write's error at once, so Workflow retries it with a fresh stream: no
// further provider request, no further write, and the cut attempt's hooks still hear it failed.

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

afterEach(() => {
  vi.restoreAllMocks();
});

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
  outputTokens: { reasoning: 0, text: 2, total: 2 },
};

function streamOf(parts: readonly StreamPart[]): StreamResult {
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

const finish = (unified: "stop" | "tool-calls"): StreamPart => ({
  finishReason: { raw: undefined, unified },
  type: "finish",
  usage,
});

const reply = (text: string): StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { id: "t", type: "text-start" },
  { delta: text, id: "t", type: "text-delta" },
  { id: "t", type: "text-end" },
  finish("stop"),
];

/** A stream that closes without output or a finish, which eve reissues once. */
const empty = (): StreamPart[] => [{ type: "stream-start", warnings: [] }];

const lookupCall = (): StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { input: "{}", toolCallId: "lookup-1", toolName: "lookup", type: "tool-call" },
  finish("tool-calls"),
];

/** What the stream rejects with: a workflow server error that would read as transient. */
const unavailable = () =>
  Object.assign(new Error("Stream write failed: HTTP 503"), { statusCode: 503 });

async function runDeadStep(options: {
  readonly doStream: MockLanguageModelV3["doStream"];
  /** The write the stream dies at. */
  readonly diesAt: (event: SessionEvent) => boolean;
  readonly cause?: () => unknown;
  /** Runs as the stream dies, before the write rejects. */
  readonly onDeath?: () => void;
  readonly steeringSignal?: AbortSignal;
}) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  let dead: SessionStreamWriteError | undefined;
  let writesAfterDeath = 0;
  const failedAttempts: unknown[] = [];
  const instrumentation: SessionInstrumentation = {
    installAiSdkWarningLogger: () => {},
    runStep: (input, execute) =>
      execute({
        createHandleEvent: ({ handleEvent }) => handleEvent,
        prepareAttempt: () => ({
          fail: async (error) => {
            failedAttempts.push(error);
          },
          scope: {} as never,
          telemetry: undefined,
        }),
        preparePreamble: async () => undefined,
        recordError: () => {},
        resolveRuntimeContext: () => undefined,
        session: input.session,
        setTurnId: () => {},
        telemetry: () => undefined,
      }),
  };
  const session: HarnessSession = {
    compaction: {},
    continuationToken: "http:dead-stream",
    history: [],
    sessionId: "dead-stream",
  };
  const step = createTestKernel({
    agent: { model: { id: "m" } },
    handleEvent: eachEvent(async (event) => {
      if (dead !== undefined) {
        writesAfterDeath += 1;
        throw new SessionStreamWriteError(dead.cause);
      }
      if (options.diesAt(event)) {
        options.onDeath?.();
        dead = new SessionStreamWriteError((options.cause ?? unavailable)());
        throw dead;
      }
    }),
    instrumentation,
    resolveModel: async () => new MockLanguageModelV3({ doStream: options.doStream }),
    steeringSignal: options.steeringSignal,
    tools: new Map([
      [
        "lookup",
        {
          description: "Looks up Alice's weekly report.",
          execute: async () => "The weekly summary.",
          inputSchema: jsonSchema({ type: "object" }),
          name: "lookup",
        },
      ],
    ]),
  });
  const outcome = await step(session, { message: "Alice asks for her weekly summary." }).then(
    () => ({ rejected: undefined }),
    (error: unknown) => ({ rejected: error }),
  );
  return { dead, failedAttempts, rejected: outcome.rejected, writesAfterDeath };
}

describe("a session stream that dies during a model step", () => {
  it("rethrows when a model call's first content write fails, without retrying it", async () => {
    const doStream = vi.fn(async () => streamOf(reply("Here is your summary.")));
    const run = await runDeadStep({
      diesAt: (event) => event.type.startsWith("content."),
      doStream,
    });

    expect(run.rejected).toBe(run.dead);
    expect(doStream).toHaveBeenCalledOnce();
    expect(run.writesAfterDeath).toBe(0);
    expect(run.failedAttempts).toEqual([run.dead]);
  });

  it("rethrows when the recovery call after an empty response can't write", async () => {
    let calls = 0;
    const doStream = vi.fn(async () =>
      streamOf(++calls === 1 ? empty() : reply("Here is your summary.")),
    );
    const run = await runDeadStep({
      diesAt: (event) => event.type.startsWith("content."),
      doStream,
    });

    expect(run.rejected).toBe(run.dead);
    expect(doStream).toHaveBeenCalledTimes(2);
    expect(run.writesAfterDeath).toBe(0);
    expect(run.failedAttempts).toEqual([run.dead]);
  });

  it("rethrows a dead stream even when steering arrives during the write", async () => {
    const steering = new AbortController();
    const doStream = vi.fn(async () => streamOf(reply("Here is your summary.")));
    const run = await runDeadStep({
      diesAt: (event) => event.type.startsWith("content."),
      doStream,
      onDeath: () => steering.abort(),
      steeringSignal: steering.signal,
    });

    expect(run.rejected).toBe(run.dead);
    expect(doStream).toHaveBeenCalledOnce();
    expect(run.writesAfterDeath).toBe(0);
    expect(run.failedAttempts).toEqual([run.dead]);
  });

  it("rethrows an aborted write as is, not as a stalled model stream", async () => {
    const doStream = vi.fn(async () => streamOf(reply("Here is your summary.")));
    const run = await runDeadStep({
      cause: () => new DOMException("The write was aborted.", "AbortError"),
      diesAt: (event) => event.type.startsWith("content."),
      doStream,
    });

    expect(run.rejected).toBe(run.dead);
    expect(run.rejected).toMatchObject({ name: "AbortError" });
    expect(doStream).toHaveBeenCalledOnce();
    expect(run.writesAfterDeath).toBe(0);
    expect(run.failedAttempts).toEqual([run.dead]);
  });

  it("rethrows when the attempt's start can't write, and its hooks hear it failed", async () => {
    const doStream = vi.fn(async () => streamOf(reply("Here is your summary.")));
    const run = await runDeadStep({
      diesAt: (event) => event.type === "model.started",
      doStream,
    });

    expect(run.rejected).toBe(run.dead);
    expect(doStream).not.toHaveBeenCalled();
    expect(run.writesAfterDeath).toBe(0);
    expect(run.failedAttempts).toEqual([run.dead]);
  });

  it("rethrows when the run's request can't write", async () => {
    const doStream = vi.fn(async () => streamOf(reply("Here is your summary.")));
    const run = await runDeadStep({
      diesAt: (event) => event.type === "model.requested",
      doStream,
    });

    expect(run.rejected).toBe(run.dead);
    expect(doStream).not.toHaveBeenCalled();
    expect(run.writesAfterDeath).toBe(0);
  });

  it("rethrows when an inline call's settlement can't write, without settling it again", async () => {
    const doStream = vi.fn(async () => streamOf(lookupCall()));
    const run = await runDeadStep({
      diesAt: (event) => event.type === "call.settled",
      doStream,
    });

    expect(run.rejected).toBe(run.dead);
    expect(doStream).toHaveBeenCalledOnce();
    expect(run.writesAfterDeath).toBe(0);
  });
});
