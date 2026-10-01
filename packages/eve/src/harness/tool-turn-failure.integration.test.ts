import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { TurnFailingToolError } from "#harness/tool-turn-failure.js";
import type { HarnessSession } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { toInputSchema } from "#tools/schema.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

function toolCallStream(toolName: string): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "call-1", toolName, input: "{}" },
        { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
      ] satisfies StreamPart[],
    }),
  };
}

function session(toolName: string): HarnessSession {
  return {
    agent: {
      modelReference: { id: "turn-failure-model" },
      system: "Help Alice.",
      tools: [
        { description: "Check Alice's draft.", inputSchema: { type: "object" }, name: toolName },
      ],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:turn-failure-session",
    history: [],
    sessionId: "turn-failure-session",
  };
}

function tool(name: string, execute: HarnessToolDefinition["execute"]): HarnessToolDefinition {
  return {
    description: "Check Alice's draft.",
    execute,
    inputSchema: toInputSchema({ type: "object" }),
    name,
  };
}

async function runTurn(toolDefinition: HarnessToolDefinition) {
  let modelCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      modelCalls++;
      return toolCallStream(toolDefinition.name);
    },
  });
  const events: UnstampedMessageStreamEvent[] = [];
  const step = createToolLoopHarness({
    resolveModel: async () => model,
    tools: new Map([[toolDefinition.name, toolDefinition]]),
    handleEvent: async (event) => {
      events.push(event);
    },
  });
  const result = await contextStorage.run(new ContextContainer(), () =>
    step(session(toolDefinition.name), { message: "Check Alice's draft." }),
  );
  return { events, modelCalls, result };
}

describe("turn-failing tool errors", () => {
  it("fail the turn after the model call that requested the tool", async () => {
    const { events, modelCalls, result } = await runTurn(
      tool("check_draft", async () => {
        throw new TurnFailingToolError("TOOL_STUB_MISSING", "No stub for check_draft.");
      }),
    );

    expect(modelCalls).toBe(1);
    expect(result.next).toBeNull();
    expect(result.settledTurn).toEqual({ isError: true, output: "No stub for check_draft." });
    expect(events.find((event) => event.type === "turn.failed")).toMatchObject({
      data: { code: "TOOL_STUB_MISSING", message: "No stub for check_draft." },
    });
    expect(events.some((event) => event.type === "session.waiting")).toBe(true);
  });

  it("also fail the turn when execute throws synchronously", async () => {
    const { events } = await runTurn(
      tool("check_draft", () => {
        throw new TurnFailingToolError("TOOL_STUB_MISSING", "No stub for check_draft.");
      }),
    );

    expect(events.find((event) => event.type === "turn.failed")).toMatchObject({
      data: { code: "TOOL_STUB_MISSING" },
    });
  });

  it("throw to callers that run the harness without an event handler", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "check_draft", input: "{}" },
        ],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage,
        warnings: [],
      }),
    });
    const step = createToolLoopHarness({
      resolveModel: async () => model,
      tools: new Map([
        [
          "check_draft",
          tool("check_draft", async () => {
            throw new TurnFailingToolError("TOOL_STUB_MISSING", "No stub for check_draft.");
          }),
        ],
      ]),
    });

    await expect(
      contextStorage.run(new ContextContainer(), () =>
        step(session("check_draft"), { message: "Check Alice's draft." }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_STUB_MISSING", name: "TurnFailingToolError" });
  });

  it("fail the turn before the model call when one is pending from outside the step", async () => {
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCalls++;
        return toolCallStream("check_draft");
      },
    });
    const events: UnstampedMessageStreamEvent[] = [];
    const step = createToolLoopHarness({
      handleEvent: async (event) => {
        events.push(event);
      },
      resolveModel: async () => model,
      takePendingTurnFailure: () =>
        new TurnFailingToolError("TOOL_STUB_MISSING", "A subagent had no stub."),
      tools: new Map(),
    });

    const result = await contextStorage.run(new ContextContainer(), () =>
      step(session("check_draft"), { message: "Check Alice's draft." }),
    );

    expect(modelCalls).toBe(0);
    expect(result.settledTurn).toEqual({ isError: true, output: "A subagent had no stub." });
    expect(events.find((event) => event.type === "turn.failed")).toMatchObject({
      data: { code: "TOOL_STUB_MISSING" },
    });
  });

  it("leave ordinary tool errors to the model", async () => {
    const { events, result } = await runTurn(
      tool("check_draft", async () => {
        throw new Error("Draft service unavailable.");
      }),
    );

    expect(result.settledTurn).toBeUndefined();
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
  });
});
