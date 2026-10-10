import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { context } from "@opentelemetry/api";
import { createAgentTracing, otelTelemetry } from "@vercel/agent-tracing";

describe("outside-eve agent", () => {
  it("runs wrapped operations and handle-based tools using only the facade", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
    const tracing = createAgentTracing({
      telemetry: otelTelemetry({ provider }),
    });
    try {
      const value = await tracing.turn(
        {
          agentName: "support",
          identity: { conversationId: "conversation", runId: "run", turnId: "turn" },
          sequence: 0,
        },
        (turn) =>
          turn.attempt({ stepIndex: 0, attempt: 0 }, async (attempt) => {
            const answer = await attempt.modelCall({ provider: "test", modelId: "model" }, () => ({
              result: "answer",
              finishReason: "stop",
              usage: { inputTokens: 3, outputTokens: 2 },
            }));
            expect(answer).toBe("answer");
            return attempt.tool({ callId: "lookup", name: "lookup" }, async (tool) => {
              await tool.approval(
                { requestId: "approval", describe: () => ({ outcome: "approved" }) },
                () => true,
              );
              return "Alice's answer";
            });
          }),
      );
      expect(value).toBe("Alice's answer");
      await tracing.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans.map((span) => span.name)).toEqual([
        "chat model",
        "agent.approval",
        "execute_tool lookup",
        "agent.step",
        "invoke_agent support",
      ]);
      const turn = spans.at(-1)!;
      expect(spans.find((span) => span.name === "agent.step")?.parentSpanContext?.spanId).toBe(
        turn.spanContext().spanId,
      );
      expect(turn.attributes["gen_ai.usage.input_tokens"]).toBe(3);
      expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("Alice");
      const handle = await tracing.turn({
        agentName: "support",
        identity: { conversationId: "conversation", runId: "next", turnId: "turn" },
        sequence: 0,
      });
      expect(handle).not.toHaveProperty("snapshot");
      await handle.complete();
    } finally {
      await tracing.shutdown();
      context.disable();
      manager.disable();
    }
  });
  it("preserves application errors and closes memory and tool callbacks", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracing = createAgentTracing({
      telemetry: otelTelemetry({ provider }),
    });
    const error = new TypeError("private failure");
    try {
      await expect(
        tracing.turn(
          {
            agentName: "support",
            identity: { conversationId: "c", runId: "r", turnId: "t" },
            sequence: 0,
          },
          (turn) =>
            turn.attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
              attempt.tool({ callId: "tool", name: "lookup" }, () => {
                throw error;
              }),
            ),
        ),
      ).rejects.toBe(error);
      const failures = exporter.getFinishedSpans();
      expect(failures).toHaveLength(3);
      expect(
        failures.every(
          (span) => span.status.code === 2 && span.attributes["error.type"] === "TypeError",
        ),
      ).toBe(true);
      expect(JSON.stringify(failures.map((span) => span.events))).not.toContain("private failure");
      await tracing.turn(
        {
          agentName: "support",
          identity: { conversationId: "c", runId: "memory", turnId: "t" },
          sequence: 0,
        },
        (turn) =>
          turn.memory(
            {
              operation: "search_memory",
              phase: "retrieve",
              slot: "history",
              storeId: "store",
              describe: () => ({ recordCount: 2 }),
            },
            () => "records",
          ),
      );
      expect(
        exporter.getFinishedSpans().find((span) => span.name === "search_memory")?.attributes[
          "gen_ai.memory.record.count"
        ],
      ).toBe(2);
    } finally {
      await tracing.shutdown();
    }
  });
  it("honors the supplied provider's root sampling decision", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      sampler: { shouldSample: () => ({ decision: 0 }), toString: () => "drop" },
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracing = createAgentTracing({
      telemetry: otelTelemetry({ provider }),
    });
    try {
      await tracing.turn(
        {
          agentName: "support",
          identity: { conversationId: "c", runId: "r", turnId: "t" },
          sequence: 0,
          capture: { emit: true, recordInputs: true, recordOutputs: true },
        },
        async (turn) => {
          expect(turn.capture).toEqual({ emit: false, recordInputs: false, recordOutputs: false });
          await turn.attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
            attempt.tool({ callId: "tool", name: "lookup" }, () => "private"),
          );
        },
      );
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    } finally {
      await tracing.shutdown();
    }
  });
});
