import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  APICallError,
  embed,
  generateText,
  streamText,
  registerTelemetry,
  ToolLoopAgent,
  tool,
} from "ai";
import { MockEmbeddingModelV3, MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRun, otelTelemetry } from "@vercel/agent-runs";
import { aiSdkTelemetry } from "@vercel/agent-runs/ai-sdk";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};
function model(modelId: string) {
  return new MockLanguageModelV3({
    modelId,
    doGenerate: {
      content: [{ type: "text", text: "Private answer" }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    },
  });
}
function recording() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const run = createAgentRun({ telemetry: otelTelemetry({ provider }) });
  return { exporter, run, provider };
}
afterEach(() => {
  globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
  context.disable();
  trace.disable();
});

describe("AI SDK adapter registration", () => {
  it("records globally registered calls without turn options", async () => {
    const { exporter, run } = recording();
    registerTelemetry(aiSdkTelemetry(run));
    try {
      await generateText({ model: model("direct"), prompt: "Private prompt" });
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(3);
      const turn = spans.find((span) => span.name.startsWith("invoke_agent"))!;
      const step = spans.find((span) => span.name === "agent.step")!;
      const inference = spans.find((span) => span.name === "chat direct")!;
      expect(new Set(spans.map((span) => span.spanContext().spanId)).size).toBe(3);
      expect(spans.every((span) => span.spanContext().traceId === turn.spanContext().traceId)).toBe(
        true,
      );
      expect(step.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
      expect(inference.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
      expect(inference.attributes).toMatchObject({
        "gen_ai.usage.input_tokens": 3,
        "gen_ai.usage.output_tokens": 2,
      });
      expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("Private");
    } finally {
      globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
      await run.shutdown();
    }
  });

  it("parents concurrent nested agents to the invoking tools and isolates top-level calls", async () => {
    const { exporter, run } = recording();
    registerTelemetry(aiSdkTelemetry(run));
    const agent = new ToolLoopAgent({ model: model("child") });
    const parent = new MockLanguageModelV3({
      modelId: "parent",
      doGenerate: {
        content: ["left", "right"].map((name) => ({
          type: "tool-call" as const,
          toolCallId: name,
          toolName: name,
          input: "{}",
        })),
        finishReason: { unified: "tool-calls", raw: undefined },
        usage,
        warnings: [],
      },
    });
    const childTool = () =>
      tool({
        inputSchema: z.object({}),
        execute: async () => {
          await Promise.resolve();
          return (await agent.generate({ prompt: "Private child prompt" })).text;
        },
      });
    try {
      await Promise.all([
        generateText({
          model: parent,
          prompt: "Private parent prompt",
          tools: { left: childTool(), right: childTool() },
        }),
        generateText({ model: model("unrelated"), prompt: "Private separate request" }),
      ]);
      const spans = exporter.getFinishedSpans();
      const tools = spans.filter((span) => span.name.startsWith("execute_tool"));
      const children = spans.filter((span) =>
        tools.some((tool) => span.parentSpanContext?.spanId === tool.spanContext().spanId),
      );
      expect(tools).toHaveLength(2);
      expect(children).toHaveLength(2);
      const unrelated = spans.find((span) => span.name === "chat unrelated")!;
      const parentModel = spans.find((span) => span.name === "chat parent")!;
      expect(unrelated.spanContext().traceId).not.toBe(parentModel.spanContext().traceId);
      for (const child of children) {
        expect(child.spanContext().traceId).toBe(parentModel.spanContext().traceId);
        expect(child.attributes["gen_ai.conversation.id"]).toBe(
          parentModel.attributes["gen_ai.conversation.id"],
        );
      }
      expect(trace.getActiveSpan()).toBeUndefined();
    } finally {
      globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
      await run.shutdown();
    }
  });
  it("reuses the configured provider and preserves independent observers", async () => {
    const { exporter, provider } = recording();
    trace.setGlobalTracerProvider(provider);
    const selected = trace.getTracerProvider();
    const run = createAgentRun({});
    const observed = vi.fn();
    registerTelemetry(aiSdkTelemetry(run), { onEnd: observed });
    try {
      await generateText({ model: model("existing-provider"), prompt: "Hello" });
      expect(exporter.getFinishedSpans()).toHaveLength(3);
      expect(observed).toHaveBeenCalledOnce();
      expect(trace.getTracerProvider()).toBe(selected);
    } finally {
      await run.shutdown();
    }
  });

  it("keeps streaming spans open until consumption finishes", async () => {
    const { exporter, run } = recording();
    registerTelemetry(aiSdkTelemetry(run));
    let activeInModel: string | undefined;
    const streaming = new MockLanguageModelV3({
      modelId: "streaming",
      doStream: async () => {
        activeInModel = trace.getActiveSpan()?.spanContext().spanId;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "answer" });
              controller.enqueue({ type: "text-delta", id: "answer", delta: "Hello" });
              controller.enqueue({ type: "text-end", id: "answer" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage,
              });
              controller.close();
            },
          }),
        };
      },
    });
    try {
      const result = streamText({ model: streaming, prompt: "Hello" });
      let text = "";
      for await (const chunk of result.textStream) {
        text += chunk;
        expect(
          exporter.getFinishedSpans().filter((span) => span.name.startsWith("invoke_agent")),
        ).toHaveLength(0);
      }
      expect(text).toBe("Hello");
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(3);
      expect(activeInModel).toBe(
        spans.find((span) => span.name === "chat streaming")?.spanContext().spanId,
      );
      expect(trace.getActiveSpan()).toBeUndefined();
    } finally {
      await run.shutdown();
    }
  });

  it.each(["generate", "stream"] as const)(
    "preserves %s model-call outcomes after a provider retry succeeds",
    async (method) => {
      const { exporter, run } = recording();
      registerTelemetry(aiSdkTelemetry(run));
      const error = new APICallError({
        message: "Private provider failure",
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 503,
        responseHeaders: { "retry-after-ms": "0" },
      });
      const attempts: (string | undefined)[] = [];
      let completedBeforeRetry: string[] = [];
      function startCall() {
        attempts.push(trace.getActiveSpan()?.spanContext().spanId);
        if (attempts.length === 1) throw error;
        completedBeforeRetry = exporter.getFinishedSpans().map((span) => span.spanContext().spanId);
      }
      const retrying = new MockLanguageModelV3({
        modelId: "retrying",
        doGenerate: async () => {
          startCall();
          return {
            content: [{ type: "text", text: "Recovered" }],
            finishReason: { unified: "stop", raw: undefined },
            usage,
            warnings: [],
          };
        },
        doStream: async () => {
          startCall();
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "text-start", id: "answer" });
                controller.enqueue({ type: "text-delta", id: "answer", delta: "Recovered" });
                controller.enqueue({ type: "text-end", id: "answer" });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop", raw: undefined },
                  usage,
                });
                controller.close();
              },
            }),
          };
        },
      });
      try {
        let text = "";
        if (method === "generate") {
          text = (await generateText({ model: retrying, prompt: "Hello", maxRetries: 1 })).text;
        } else {
          const result = streamText({ model: retrying, prompt: "Hello", maxRetries: 1 });
          for await (const chunk of result.textStream) text += chunk;
        }
        expect(text).toBe("Recovered");
        expect(attempts).toHaveLength(2);
        const spans = exporter.getFinishedSpans();
        const models = spans.filter((span) => span.name === "chat retrying");
        const successful = models.find((span) => span.spanContext().spanId === attempts[1])!;
        const turn = spans.find((span) => span.name.startsWith("invoke_agent"))!;
        const step = spans.find((span) => span.name === "agent.step")!;
        expect(successful.status.code).toBe(0);
        expect(successful.attributes["error.type"]).toBeUndefined();
        expect(successful.attributes["gen_ai.usage.input_tokens"]).toBe(3);
        expect(turn.attributes["agent.turn.outcome"]).toBe("completed");
        expect(turn.status.code).toBe(0);
        expect(step.status.code).toBe(0);
        expect(
          models.every((span) => span.parentSpanContext?.spanId === step.spanContext().spanId),
        ).toBe(true);
        expect(
          spans.every((span) => span.spanContext().traceId === turn.spanContext().traceId),
        ).toBe(true);
        if (method === "stream") {
          expect(spans).toHaveLength(4);
          const failed = models.find((span) => span.spanContext().spanId === attempts[0])!;
          expect(failed.status.code).toBe(2);
          expect(failed.attributes["error.type"]).toBe(error.name);
          expect(completedBeforeRetry).toContain(attempts[0]);
        } else {
          expect(spans).toHaveLength(3);
          expect(attempts[0]).toBe(attempts[1]);
        }
        expect(
          JSON.stringify(
            spans.map((span) => ({
              attributes: span.attributes,
              events: span.events,
              status: span.status,
            })),
          ),
        ).not.toContain("Private provider failure");
      } finally {
        await run.shutdown();
      }
    },
  );

  it("preserves explicit conversation identity across calls without joining unrelated trace trees", async () => {
    const { exporter, run } = recording();
    registerTelemetry(
      aiSdkTelemetry(run, {
        turn: { identity: { conversationId: "conversation-1", runId: "run-1" } },
      }),
    );
    try {
      await generateText({ model: model("first"), prompt: "Hello" });
      await generateText({ model: model("second"), prompt: "Hello again" });
      const roots = exporter
        .getFinishedSpans()
        .filter((span) => span.name.startsWith("invoke_agent"));
      expect(roots).toHaveLength(2);
      expect(
        roots.every(
          (span) =>
            span.attributes["gen_ai.conversation.id"] === "conversation-1" &&
            span.attributes["agent.run.id"] === "run-1",
        ),
      ).toBe(true);
      expect(roots[0]!.spanContext().traceId).not.toBe(roots[1]!.spanContext().traceId);
      expect(roots[0]!.attributes["agent.turn.id"]).not.toBe(roots[1]!.attributes["agent.turn.id"]);
    } finally {
      await run.shutdown();
    }
  });

  it("narrows nested capture across adapter instances", async () => {
    const { exporter, run, provider } = recording();
    const childRun = createAgentRun({ telemetry: otelTelemetry({ provider }) });
    const childAdapter = aiSdkTelemetry(childRun, {
      turn: { capture: { emit: true, recordInputs: true, recordOutputs: true } },
    });
    registerTelemetry(aiSdkTelemetry(run));
    const parent = new MockLanguageModelV3({
      modelId: "parent",
      doGenerate: {
        content: [{ type: "tool-call", toolCallId: "child", toolName: "child", input: "{}" }],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage,
        warnings: [],
      },
    });
    try {
      await generateText({
        model: parent,
        prompt: "Private parent",
        tools: {
          child: tool({
            inputSchema: z.object({}),
            execute: async () =>
              (
                await generateText({
                  model: model("child"),
                  prompt: "Private child",
                  telemetry: { integrations: [childAdapter] },
                })
              ).text,
          }),
        },
      });
      const spans = exporter.getFinishedSpans();
      const childRoot = spans.find((span) => span.attributes["agent.parent_run.id"] !== undefined);
      const parentTool = spans.find((span) => span.name === "execute_tool child")!;
      expect(spans).toHaveLength(7);
      expect(childRoot?.parentSpanContext?.spanId).toBe(parentTool.spanContext().spanId);
      expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("Private");
    } finally {
      await run.shutdown();
    }
  });

  it("parents model-initiated nested calls to the active model span", async () => {
    const { exporter, run } = recording();
    registerTelemetry(aiSdkTelemetry(run));
    const parent = new MockLanguageModelV3({
      modelId: "parent",
      doGenerate: async () => {
        await generateText({ model: model("inner"), prompt: "Hello" });
        return {
          content: [{ type: "text", text: "Hello" }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        };
      },
    });
    try {
      await generateText({ model: parent, prompt: "Hello" });
      const spans = exporter.getFinishedSpans();
      const parentSpan = spans.find((span) => span.name === "chat parent")!;
      expect(spans).toHaveLength(6);
      expect(
        spans.filter((span) => span.parentSpanContext?.spanId === parentSpan.spanContext().spanId),
      ).toHaveLength(1);
    } finally {
      await run.shutdown();
    }
  });

  it("keeps content serialization with the configured Agent Runs serializer", async () => {
    const { exporter, provider } = recording();
    const omit = () => undefined;
    const run = createAgentRun({
      telemetry: otelTelemetry({ provider }),
      serializer: {
        json: omit,
        text: omit,
        inputMessages: () => ({ json: "redacted-input", omitted: 0 }),
        instructions: omit,
        toolDefinitions: omit,
        outputMessages: () => "redacted-output",
        toolResults: omit,
      },
    });
    registerTelemetry(
      aiSdkTelemetry(run, {
        turn: { capture: { emit: true, recordInputs: true, recordOutputs: true } },
      }),
    );
    try {
      await generateText({ model: model("redacted"), prompt: "Private prompt" });
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(3);
      const attributes = JSON.stringify(spans.map((span) => span.attributes));
      expect(attributes).toContain("redacted-input");
      expect(attributes).toContain("redacted-output");
      expect(attributes).not.toContain("Private");
    } finally {
      await run.shutdown();
    }
  });

  it("closes an aborted stream and isolates the following call", async () => {
    const { exporter, run } = recording();
    registerTelemetry(aiSdkTelemetry(run));
    const abort = new AbortController();
    const streaming = new MockLanguageModelV3({
      modelId: "aborted",
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "answer" });
            controller.enqueue({ type: "text-delta", id: "answer", delta: "Hello" });
            abortSignal?.addEventListener("abort", () => controller.error(abortSignal.reason), {
              once: true,
            });
          },
        }),
      }),
    });
    try {
      const result = streamText({ model: streaming, prompt: "Hello", abortSignal: abort.signal });
      for await (const _chunk of result.textStream) abort.abort();
      const aborted = [...exporter.getFinishedSpans()];
      expect(aborted).toHaveLength(3);
      expect(
        aborted.find((span) => span.name.startsWith("invoke_agent"))?.attributes[
          "agent.turn.outcome"
        ],
      ).toBe("cancelled");
      await generateText({ model: model("after-abort"), prompt: "Hello again" });
      const following = exporter
        .getFinishedSpans()
        .find((span) => span.name === "chat after-abort")!;
      expect(
        aborted.every((span) => span.spanContext().traceId !== following.spanContext().traceId),
      ).toBe(true);
      expect(trace.getActiveSpan()).toBeUndefined();
    } finally {
      await run.shutdown();
    }
  });
  it("preserves native instrumentation for operations not grouped into Agent Runs yet", async () => {
    const { exporter, provider } = recording();
    trace.setGlobalTracerProvider(provider);
    const run = createAgentRun({});
    registerTelemetry(aiSdkTelemetry(run));
    try {
      const result = await embed({
        model: new MockEmbeddingModelV3({
          modelId: "embedding",
          doEmbed: {
            embeddings: [[1, 2, 3]],
            usage: { tokens: 4 },
            warnings: [],
          },
        }),
        value: "Private embedding input",
      });
      expect(result.embedding).toEqual([1, 2, 3]);
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(2);
      expect(spans.every((span) => span.name === "embeddings embedding")).toBe(true);
      expect(spans[0]!.parentSpanContext?.spanId).toBe(spans[1]!.spanContext().spanId);
      expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("Private");
    } finally {
      await run.shutdown();
    }
  });
});
