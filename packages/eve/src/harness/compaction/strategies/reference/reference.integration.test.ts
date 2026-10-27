import { jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { executeReadFileOnSandbox } from "#execution/sandbox/read-file.js";
import type { CompactionStrategy } from "#harness/compaction/strategy.js";
import { referenceCompaction } from "#harness/compaction/strategies/reference/index.js";
import { eventsOf } from "#harness/publication.js";
import { estimateTokens } from "#harness/token-estimate.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession } from "#harness/types.js";
import { foldingHandler } from "#internal/testing/session-machine.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { SessionEvent } from "#protocol/session-event.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = (inputTokens: number) => ({
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: inputTokens, total: inputTokens },
  outputTokens: { reasoning: 0, text: 4, total: 4 },
});

const stream = (parts: unknown[]): StreamResult => ({
  stream: new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of parts as StreamPart[]) controller.enqueue(part);
      controller.close();
    },
  }),
});

const textReply = (text: string, inputTokens: number) =>
  stream([
    { type: "stream-start", warnings: [] },
    { id: "t", type: "text-start" },
    { delta: text, id: "t", type: "text-delta" },
    { id: "t", type: "text-end" },
    {
      finishReason: { raw: undefined, unified: "stop" },
      type: "finish",
      usage: usage(inputTokens),
    },
  ]);

const toolCall = (input: unknown) =>
  stream([
    { type: "stream-start", warnings: [] },
    {
      input: JSON.stringify(input),
      toolCallId: "read-1",
      toolName: "read_file",
      type: "tool-call",
    },
    { finishReason: { raw: undefined, unified: "tool-calls" }, type: "finish", usage: usage(300) },
  ]);

function session(history: HarnessSession["history"], threshold: number): HarnessSession {
  return {
    agent: { modelReference: { id: "turn-model" }, system: "You help Alice.", tools: [] },
    compaction: { recentWindowSize: 1, threshold },
    continuationToken: "http:reference",
    history,
    sessionId: "reference",
  };
}

async function run(input: {
  readonly message: string;
  readonly model: MockLanguageModelV3;
  readonly session: HarnessSession;
  readonly strategy: CompactionStrategy;
  readonly sandbox: ReturnType<typeof mockSandbox>;
}) {
  const events: SessionEvent[] = [];
  const handle = foldingHandler();
  const readFile = {
    name: "read_file",
    description: "Read a file",
    inputSchema: jsonSchema({ type: "object" }),
    execute: async (args: { filePath: string; offset?: number; limit?: number }) =>
      executeReadFileOnSandbox(input.sandbox.session, args),
  };
  const ctx = new ContextContainer();
  ctx.set(SandboxKey, input.sandbox.access);
  let final = input.session;
  await contextStorage.run(ctx, async () => {
    let stepped = await createToolLoopHarness({
      compactionStrategy: input.strategy,
      handleEvent: async (publication) => {
        events.push(...eventsOf(publication));
        await handle(publication);
      },
      resolveModel: async () => input.model,
      tools: new Map([["read_file", readFile]]),
    })(input.session, { message: input.message });
    while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
    final = stepped.session;
  });
  return { events, session: final };
}

/** Wraps a strategy to record the token counts around its compaction. */
function measured(strategy: CompactionStrategy) {
  const counts: { before: number; after: number; envelope: number }[] = [];
  const wrapped: CompactionStrategy = {
    async compact(history, context) {
      const result = await strategy.compact(history, context);
      counts.push({
        before: context.inputTokens,
        after: estimateTokens(result) + context.requestEnvelopeTokens,
        envelope: context.requestEnvelopeTokens,
      });
      return result;
    },
  };
  return { counts, wrapped };
}

describe("reference compaction", () => {
  it("replaces a 408 KB message with a file reference instead of summarizing", async () => {
    const sandbox = mockSandbox();
    const text = "lorem ipsum dolor sit amet ".repeat(15_112).slice(0, 408_000);
    expect(text).toHaveLength(408_000);
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        return textReply("Done.", 900);
      },
    });
    const { counts, wrapped } = measured(referenceCompaction());

    const { events, session: final } = await run({
      message: text,
      model,
      sandbox,
      session: session([], 100_000),
      strategy: wrapped,
    });

    expect(prompts).toHaveLength(1);
    expect(events.filter((event) => event.type === "context.started")).toHaveLength(1);
    expect(events.map(({ type }) => type)).toContain("turn.settled");
    expect(events.some((event) => event.type === "session.ended")).toBe(false);
    expect(counts[0]!.before).toBeGreaterThan(100_000);
    expect(counts[0]!.after).toBeLessThan(1_000);
    const [write] = sandbox.writes;
    expect(write!.path).toMatch(/\.eve\/compaction\/[0-9a-f]{16}\.txt$/);
    expect(Buffer.from(write!.content).toString("utf8")).toBe(text);
    const first = final.history[0]!;
    expect(JSON.stringify(first.content)).toContain("408000 bytes");
    console.log("408KB case tokens", JSON.stringify(counts[0]));
  });

  it("replaces a 120 KB tool output with a reference the model reads back", async () => {
    const sandbox = mockSandbox();
    const lines = Array.from({ length: 4_000 }, (_, i) => `row ${i}: ${"x".repeat(20)}`);
    const output = lines.join("\n");
    expect(output.length).toBeGreaterThan(100_000);
    const history: HarnessSession["history"] = [
      { content: "Dump the table.", kind: "user", role: "user" },
      {
        content: [{ input: {}, toolCallId: "c1", toolName: "dump", type: "tool-call" }],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "text", value: output },
            toolCallId: "c1",
            toolName: "dump",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      { content: "Got it.", role: "assistant" },
    ];
    const prompts: { role: string; content: unknown }[][] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push([...prompt] as never);
        if (prompts.length === 1) {
          const stub = JSON.stringify(prompt);
          const path = /moved to (\S+\.txt)/.exec(stub)?.[1];
          if (path === undefined) throw new Error("no reference in the first prompt");
          return toolCall({ filePath: path, offset: 3_999, limit: 2 });
        }
        return textReply("Row 3999 is the last one.", 600);
      },
    });
    const { counts, wrapped } = measured(referenceCompaction());

    const { events } = await run({
      message: "What is the last row?",
      model,
      sandbox,
      session: session(history, 20_000),
      strategy: wrapped,
    });

    expect(events.some((event) => event.type === "session.ended")).toBe(false);
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[0])).not.toContain("row 2000:");
    expect(JSON.stringify(prompts[0])).toContain("122889 bytes");
    const secondPrompt = JSON.stringify(prompts[1]);
    expect(secondPrompt).toContain("row 3999: xxxxxxxxxxxxxxxxxxxx");
    expect(counts[0]!.before).toBeGreaterThan(20_000);
    expect(counts[0]!.after).toBeLessThan(2_000);
    console.log("tool output case tokens", JSON.stringify(counts[0]), "bytes", output.length);
  });
});
