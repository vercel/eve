import { jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createKernel } from "#harness/kernel.js";
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
    agent: { modelReference: { id: "m" }, system: "You help Alice.", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:attempts",
    history: [],
    sessionId: "attempts",
  };
  await createKernel({
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
  return events.filter((event) => event.type.startsWith("model."));
}

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
    ]);
  });
});

describe("run attributes", () => {
  it("tags the turn's run with what its model call spent, through the sink it's given", async () => {
    const setAttributes = vi.fn(async () => {});
    await createKernel({
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
        agent: { modelReference: { id: "m" }, system: "You help Alice.", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
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
