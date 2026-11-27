import { APICallError, jsonSchema, TypeValidationError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestKernel } from "#internal/testing/kernel.js";
import { createUserMessage } from "#harness/messages.js";
import { eventsOf } from "#harness/publication.js";
import type { HarnessSession } from "#harness/types.js";
import { eachEvent } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";

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

const reply = (text: string): StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { id: "t", type: "text-start" },
  { delta: text, id: "t", type: "text-delta" },
  { id: "t", type: "text-end" },
  { finishReason: { raw: undefined, unified: "stop" }, type: "finish", usage },
];

const overloaded = (): StreamResult =>
  streamOf([
    { type: "stream-start", warnings: [] },
    { error: { message: "Overloaded", type: "overloaded_error" }, type: "error" },
  ]);

async function runTurn(
  doStream: MockLanguageModelV3["doStream"],
  execute = async () => "The weekly summary.",
): Promise<SessionEvent[]> {
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const events: SessionEvent[] = [];
  const session: HarnessSession = {
    compaction: {},
    continuationToken: "http:attempts",
    history: [],
    sessionId: "attempts",
  };
  await createTestKernel({
    agent: { model: { id: "m" } },
    handleEvent: eachEvent(async (event) => {
      events.push(event);
    }),
    resolveModel: async () => new MockLanguageModelV3({ doStream }),
    tools: new Map([
      [
        "lookup",
        {
          description: "Looks up a report.",
          execute,
          inputSchema: jsonSchema({ type: "object" }),
          name: "lookup",
        },
      ],
    ]),
  })(session, { message: "Alice asks for the weekly summary." });
  return events.filter(
    (event) => event.type.startsWith("model.") || event.type === "usage.recorded",
  );
}

const spent = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 2 };

const billedEmpty = (
  finish: "other" | "content-filter",
  before: readonly StreamPart[] = [],
): StreamResult =>
  streamOf([
    { type: "stream-start", warnings: [] },
    ...before,
    {
      finishReason: { raw: undefined, unified: finish },
      providerMetadata: { gateway: { cost: "0.05" } },
      type: "finish",
      usage: {
        inputTokens: { cacheRead: 2_000, cacheWrite: 0, noCache: 10_000, total: 12_000 },
        outputTokens: { reasoning: 0, text: 300, total: 300 },
      },
    },
  ]);
const billed = {
  cacheReadTokens: 2_000,
  cacheWriteTokens: 0,
  costUsd: 0.05,
  inputTokens: 12_000,
  outputTokens: 300,
};

const terminated = (before: readonly StreamPart[] = []): StreamResult =>
  streamOf([
    { type: "stream-start", warnings: [] },
    ...before,
    {
      error: {
        code: "gateway_stream_terminated",
        message: "Upstream stream ended before terminal chunk",
        origin: "gateway",
        upstream_finish_received: false,
      },
      type: "error",
    },
  ]);

const malformed = (): StreamResult => ({
  stream: new ReadableStream<StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.error(
        new TypeValidationError({
          cause: new Error("Invalid input: expected string, received undefined"),
          value: { type: "response.output_text.delta" },
        }),
      );
    },
  }),
});

describe("model attempts", () => {
  it.each([
    { failure: overloaded, message: "overloaded" },
    { failure: terminated, message: "ended before the response finished" },
    { failure: malformed, message: "Type validation failed" },
  ])(
    "retries an attempt that published nothing in the same run, and says so ($message)",
    async ({ failure, message }) => {
      const doStream = vi
        .fn<MockLanguageModelV3["doStream"]>()
        .mockResolvedValueOnce(failure())
        .mockImplementation(async () => streamOf(reply("Here it is.")));

      const facts = await runTurn(doStream);

      expect(facts.map(({ data, type }) => ({ type, ...data }))).toMatchObject([
        { runId: "run_0", type: "model.requested" },
        { attempt: 0, runId: "run_0", type: "model.started" },
        {
          attempt: 0,
          error: { code: "MODEL_CALL_FAILED", message: expect.stringContaining(message) },
          runId: "run_0",
          type: "model.retried",
        },
        { attempt: 1, runId: "run_0", type: "model.started" },
        { outcome: "completed", runId: "run_0", type: "model.settled" },
        { owner: { runId: "run_0" }, type: "usage.recorded", usage: spent },
      ]);
    },
  );

  it("gives up a run whose attempt published output, and its replacement counts on", async () => {
    const execute = vi.fn(async () => "The weekly summary.");
    const doStream = vi
      .fn<MockLanguageModelV3["doStream"]>()
      .mockResolvedValueOnce(
        terminated([
          { id: "t", type: "text-start" },
          { delta: "Looking", id: "t", type: "text-delta" },
          { input: "{}", toolCallId: "call_0", toolName: "lookup", type: "tool-call" },
        ]),
      )
      .mockImplementation(async () => streamOf(reply("Here it is.")));

    const facts = await runTurn(doStream, execute);

    expect(execute).not.toHaveBeenCalled();
    expect(facts.map(({ data, type }) => ({ type, ...data }))).toMatchObject([
      { runId: "run_0", type: "model.requested" },
      { attempt: 0, runId: "run_0", type: "model.started" },
      { outcome: "abandoned", runId: "run_0", type: "model.settled" },
      { runId: "run_1", type: "model.requested" },
      { attempt: 1, runId: "run_1", type: "model.started" },
      { outcome: "completed", runId: "run_1", type: "model.settled" },
      { owner: { runId: "run_1" }, type: "usage.recorded", usage: spent },
    ]);
  });

  it("records what an empty answer it reissued spent, beside the kept answer's usage", async () => {
    const doStream = vi
      .fn<MockLanguageModelV3["doStream"]>()
      .mockResolvedValueOnce(billedEmpty("other"))
      .mockImplementation(async () => streamOf(reply("Here it is.")));

    const facts = await runTurn(doStream);

    expect(facts.map(({ data, type }) => ({ type, ...data }))).toEqual([
      { owner: { turnId: "turn_0" }, runId: "run_0", type: "model.requested" },
      { attempt: 0, modelId: "m", runId: "run_0", type: "model.started" },
      { attempt: 0, error: expect.anything(), runId: "run_0", type: "model.retried" },
      { kind: "model", owner: { runId: "run_0" }, type: "usage.recorded", usage: billed },
      { attempt: 1, modelId: "m", runId: "run_0", type: "model.started" },
      expect.objectContaining({ outcome: "completed", runId: "run_0", type: "model.settled" }),
      { kind: "model", owner: { runId: "run_0" }, type: "usage.recorded", usage: spent },
    ]);
  });

  it("records what an empty answer that published reasoning spent on the run it gave up", async () => {
    const doStream = vi
      .fn<MockLanguageModelV3["doStream"]>()
      .mockResolvedValueOnce(
        billedEmpty("other", [
          { id: "r", type: "reasoning-start" },
          { delta: "Checking the report.", id: "r", type: "reasoning-delta" },
          { id: "r", type: "reasoning-end" },
        ]),
      )
      .mockImplementation(async () => streamOf(reply("Here it is.")));

    const facts = await runTurn(doStream);

    expect(facts.map(({ data, type }) => ({ type, ...data }))).toMatchObject([
      { runId: "run_0", type: "model.requested" },
      { attempt: 0, runId: "run_0", type: "model.started" },
      { outcome: "abandoned", runId: "run_0", type: "model.settled" },
      { owner: { runId: "run_0" }, type: "usage.recorded", usage: billed },
      { runId: "run_1", type: "model.requested" },
      { attempt: 1, runId: "run_1", type: "model.started" },
      { outcome: "completed", runId: "run_1", type: "model.settled" },
      { owner: { runId: "run_1" }, type: "usage.recorded", usage: spent },
    ]);
  });

  it("fails the run with what the answer it discarded spent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const facts = await runTurn(async () => billedEmpty("content-filter"));

    expect(facts.slice(-2).map(({ data, type }) => ({ type, ...data }))).toMatchObject([
      { outcome: "failed", runId: "run_0", type: "model.settled" },
      { owner: { runId: "run_0" }, type: "usage.recorded", usage: billed },
    ]);
  });

  it("coalesces model.requested and model.started into one publication when no model.requested hook subscribes", async () => {
    const batches: string[][] = [];
    const session: HarnessSession = {
      compaction: {},
      continuationToken: "http:coalesce",
      history: [],
      sessionId: "coalesce",
    };
    await createTestKernel({
      agent: { model: { id: "m" } },
      handleEvent: async (publication) => {
        const types = eventsOf(publication).map((event) => event.type);
        if (types.includes("model.requested") || types.includes("model.started")) {
          batches.push(types);
        }
      },
      resolveModel: async () =>
        new MockLanguageModelV3({ doStream: async () => streamOf(reply("Done.")) }),
      tools: new Map(),
    })(session, { message: "Hello." });

    expect(batches).toEqual([["model.requested", "model.started"]]);
  });

  it("propagates non-provider errors from committing model.requested/model.started without entering provider retries", async () => {
    for (const error of [
      new Error("boundary write rejected"),
      Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }),
      Object.assign(new Error("Unauthorized"), { statusCode: 401 }),
      Object.assign(new Error("prompt is too long: 250000 tokens > 200000 maximum"), {
        statusCode: 400,
      }),
    ]) {
      const doStream = vi.fn(async () => streamOf(reply("Never reached.")));
      const session: HarnessSession = {
        compaction: {},
        continuationToken: "http:boundary-error",
        history: [
          createUserMessage("user", "Earlier message."),
          { content: "Earlier reply.", role: "assistant" },
        ],
        sessionId: "boundary-error",
      };
      let calls = 0;
      await expect(
        createTestKernel({
          agent: { model: { id: "m" } },
          handleEvent: async (publication) => {
            if (eventsOf(publication).some((event) => event.type === "model.requested")) {
              calls += 1;
              throw error;
            }
          },
          resolveModel: async () => new MockLanguageModelV3({ doStream }),
          tools: new Map(),
        })(session, { message: "Hello." }),
      ).rejects.toBe(error);
      expect(calls).toBe(1);
      expect(doStream).not.toHaveBeenCalled();
    }
  });
});

describe("run attributes", () => {
  it("tags the turn's run with what its model call spent, through the sink it's given", async () => {
    const setAttributes = vi.fn(async () => {});
    await createTestKernel({
      agent: { model: { id: "m" } },
      handleEvent: async () => {},
      resolveModel: async () =>
        new MockLanguageModelV3({ doStream: async () => streamOf(reply("Here it is.")) }),
      setAttributes,
      tools: new Map([
        [
          "lookup",
          {
            description: "Looks up a report.",
            execute: async () => "The weekly summary.",
            inputSchema: jsonSchema({ type: "object" }),
            name: "lookup",
          },
        ],
      ]),
    })(
      {
        compaction: {},
        continuationToken: "http:attributes",
        history: [],
        sessionId: "attributes",
      },
      { message: "Alice asks for the weekly summary." },
    );

    expect(setAttributes).toHaveBeenCalledTimes(1);
    expect(setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "$eve.input_tokens": 10,
        "$eve.output_tokens": 2,
        "$eve.tool_count": 1,
      }),
    );
  });
});

describe("a failed model call", () => {
  it("keeps the person's message in history", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const events: SessionEvent[] = [];
    const message = "Alice asks for the weekly summary.";
    const result = await createTestKernel({
      agent: { model: { id: "m" } },
      handleEvent: eachEvent(async (event) => {
        events.push(event);
      }),
      resolveModel: async () =>
        new MockLanguageModelV3({
          doStream: async () => {
            throw new APICallError({
              isRetryable: false,
              message: "Bad Request",
              requestBodyValues: {},
              statusCode: 400,
              url: "https://provider.example/v1/messages",
            });
          },
        }),
      tools: new Map(),
    })(
      {
        compaction: {},
        continuationToken: "http:failed-call",
        history: [],
        sessionId: "failed-call",
      },
      { message },
    );

    expect(events.find((event) => event.type === "model.settled")).toMatchObject({
      data: { outcome: "failed" },
    });
    expect(result.session.history).toContainEqual(
      expect.objectContaining({ content: message, role: "user" }),
    );
  });
});
