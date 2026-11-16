import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createAgentRun, otelTelemetry, type AgentRun } from "@vercel/agent-runs";
import { activeTraceOperation } from "@vercel/agent-runs/otel";

const identity = { conversationId: "alice-conversation", runId: "alice-run", turnId: "turn-1" };
const store = { storeId: "memscope1_alice", slot: "profile" };

let exporter: InMemorySpanExporter;
let manager: AsyncLocalStorageContextManager;
let tracing: AgentRun;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);
  tracing = createAgentRun({ telemetry: otelTelemetry({ provider }) });
});

afterEach(async () => {
  context.disable();
  manager.disable();
  await tracing.shutdown();
});

const span = (name: string) => exporter.getFinishedSpans().find((next) => next.name === name)!;

describe("memory tool store", () => {
  it.each([
    { recordInputs: true, recordOutputs: true },
    { recordInputs: false, recordOutputs: false },
  ])(
    "names the store on the tool span a memory tool runs in (content $recordInputs)",
    async (content) => {
      const capture = { emit: true, ...content };
      const turn = await tracing.turn({ agentName: "support", identity, sequence: 0, capture });
      const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
      const tool = await attempt.tool({ callId: "call-1", name: "profile__save" });

      await tool.run(async () => activeTraceOperation()?.memory?.store(store));
      await tool.complete();
      await attempt.complete();
      await turn.complete();

      expect(span("execute_tool profile__save").attributes).toMatchObject({
        "gen_ai.memory.store.id": "memscope1_alice",
        "agent.memory.slot": "profile",
      });
    },
  );

  it("offers the store only inside tool operations", async () => {
    const capture = { emit: true, recordInputs: false, recordOutputs: false };
    const turn = await tracing.turn({ agentName: "support", identity, sequence: 0, capture });
    const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });

    const memory = attempt.run(() => activeTraceOperation()?.memory);
    await attempt.complete();
    await turn.complete();

    expect(memory).toBeUndefined();
    expect(span("agent.step").attributes).not.toHaveProperty("gen_ai.memory.store.id");
  });
});
