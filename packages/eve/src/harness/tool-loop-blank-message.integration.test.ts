import { type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessEmitFn, HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

type DoStreamOptions = Parameters<MockLanguageModelV3["doStream"]>[0];
type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
} as const;

const TEAMS_CONTEXT = "<teams_context>\nresponse_medium: microsoft_teams\n</teams_context>";

function createSession(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "blank-message-model" },
      system: "You are a test assistant.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:blank-message-session",
    history: [],
    sessionId: "blank-message-session",
  };
}

function createEventCollector(): {
  readonly emit: HarnessEmitFn;
  readonly events: HandleMessageStreamEvent[];
} {
  const events: HandleMessageStreamEvent[] = [];
  return {
    emit: async (event) => {
      events.push(event);
    },
    events,
  };
}

function createConfig(model: LanguageModel, emit: HarnessEmitFn): ToolLoopHarnessConfig {
  return {
    handleEvent: emit,
    mode: "task",
    resolveModel: vi.fn().mockResolvedValue(model),
    tools: new Map(),
  };
}

function enqueueTextSuccess(
  controller: ReadableStreamDefaultController<StreamPart>,
  text: string,
): void {
  controller.enqueue({ type: "stream-start", warnings: [] });
  controller.enqueue({ id: "answer", type: "text-start" });
  controller.enqueue({ delta: text, id: "answer", type: "text-delta" });
  controller.enqueue({ id: "answer", type: "text-end" });
  controller.enqueue({
    finishReason: { raw: undefined, unified: "stop" },
    type: "finish",
    usage,
  });
  controller.close();
}

/** Every text part across all user messages in the captured model prompt. */
function userTextParts(options: DoStreamOptions): string[] {
  const texts: string[] = [];
  for (const message of options.prompt) {
    if (message.role !== "user") continue;
    for (const part of message.content) {
      if (part.type === "text") texts.push(part.text);
    }
  }
  return texts;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tool loop blank turn message", () => {
  // Regression: a bare `@bot` mention reaches the harness as an empty string
  // alongside a channel context block. Pushing it produced an empty user text
  // block; once a prompt-cache breakpoint landed on that block the provider
  // rejected the request with
  // `cache_control cannot be set for empty text blocks`.
  it("omits the empty turn message but keeps the context block", async () => {
    let captured: DoStreamOptions | undefined;
    const doStream = vi.fn(async (options: DoStreamOptions) => {
      captured = options;
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            enqueueTextSuccess(controller, "Hi! How can I help?");
          },
        }),
      };
    });
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "blank-message-model",
      provider: "eve-integration-mock",
    });
    const { emit } = createEventCollector();

    const result = await createToolLoopHarness(createConfig(model, emit))(createSession(), {
      context: [TEAMS_CONTEXT],
      message: "",
    });

    expect(result.next).toEqual({ done: true, output: "Hi! How can I help?" });
    expect(captured).toBeDefined();

    const texts = userTextParts(captured!);
    expect(texts).toContain(TEAMS_CONTEXT);
    expect(texts.every((text) => text.trim().length > 0)).toBe(true);
  });

  it("omits a whitespace-only turn message too", async () => {
    let captured: DoStreamOptions | undefined;
    const doStream = vi.fn(async (options: DoStreamOptions) => {
      captured = options;
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            enqueueTextSuccess(controller, "Hello.");
          },
        }),
      };
    });
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "blank-message-model",
      provider: "eve-integration-mock",
    });
    const { emit } = createEventCollector();

    await createToolLoopHarness(createConfig(model, emit))(createSession(), {
      context: [TEAMS_CONTEXT],
      message: "   \n\t ",
    });

    const texts = userTextParts(captured!);
    expect(texts.every((text) => text.trim().length > 0)).toBe(true);
  });

  it("still pushes a non-empty turn message", async () => {
    let captured: DoStreamOptions | undefined;
    const doStream = vi.fn(async (options: DoStreamOptions) => {
      captured = options;
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            enqueueTextSuccess(controller, "Answer.");
          },
        }),
      };
    });
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "blank-message-model",
      provider: "eve-integration-mock",
    });
    const { emit } = createEventCollector();

    await createToolLoopHarness(createConfig(model, emit))(createSession(), {
      context: [TEAMS_CONTEXT],
      message: "What is the status?",
    });

    const texts = userTextParts(captured!);
    expect(texts).toContain("What is the status?");
  });
});
