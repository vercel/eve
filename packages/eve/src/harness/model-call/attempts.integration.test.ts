import { APICallError, jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestKernel } from "#internal/testing/kernel.js";
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

/** A provider overloaded mid-stream, which eve retries and the AI SDK doesn't. */
const overloaded = (before: readonly StreamPart[] = []): StreamResult =>
  streamOf([
    { type: "stream-start", warnings: [] },
    ...before,
    { error: { message: "Overloaded", type: "overloaded_error" }, type: "error" },
  ]);

async function runTurn(doStream: MockLanguageModelV3["doStream"]): Promise<SessionEvent[]> {
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
          execute: async () => "The weekly summary.",
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

/** An answer with no text and no calls, which the provider billed with an AI Gateway cost. */
const billedEmpty = (finish: "other" | "content-filter"): StreamResult =>
  streamOf([
    { type: "stream-start", warnings: [] },
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

describe("model attempts", () => {
  it("retries an attempt that published nothing in the same run, and says so", async () => {
    const doStream = vi
      .fn<MockLanguageModelV3["doStream"]>()
      .mockResolvedValueOnce(overloaded())
      .mockImplementation(async () => streamOf(reply("Here it is.")));

    const facts = await runTurn(doStream);

    expect(facts.map(({ data, type }) => ({ type, ...data }))).toMatchObject([
      { runId: "run_0", type: "model.requested" },
      { attempt: 0, runId: "run_0", type: "model.started" },
      {
        attempt: 0,
        error: { code: "MODEL_CALL_FAILED", message: expect.stringContaining("overloaded") },
        runId: "run_0",
        type: "model.retried",
      },
      { attempt: 1, runId: "run_0", type: "model.started" },
      { outcome: "completed", runId: "run_0", type: "model.settled" },
      { owner: { runId: "run_0" }, type: "usage.recorded", usage: spent },
    ]);
  });

  it("gives up a run whose attempt published output, and its replacement counts on", async () => {
    const doStream = vi
      .fn<MockLanguageModelV3["doStream"]>()
      .mockResolvedValueOnce(
        // The call it announced is output: a retry can't take it back.
        overloaded([{ input: "{}", toolCallId: "call_0", toolName: "lookup", type: "tool-call" }]),
      )
      .mockImplementation(async () => streamOf(reply("Here it is.")));

    const facts = await runTurn(doStream);

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

  // The provider billed the answers eve discards, so the run counts them, as a steered one does.
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

  it("fails the run with what the answer it discarded spent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const facts = await runTurn(async () => billedEmpty("content-filter"));

    expect(facts.slice(-2).map(({ data, type }) => ({ type, ...data }))).toMatchObject([
      { outcome: "failed", runId: "run_0", type: "model.settled" },
      { owner: { runId: "run_0" }, type: "usage.recorded", usage: billed },
    ]);
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
    // The input joins history before the call, so a call that fails can't lose it.
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
