import { context as apiContext } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAgentRun,
  otelTelemetry,
  type AgentRun,
} from "#compiled/@vercel/agent-runs/index.js";
import { recordMemoryToolStore } from "#tracing/eve/agent-memory-instrumentation.js";

const identity = { conversationId: "alice-conversation", runId: "alice-run", turnId: "turn_0" };
const capture = { emit: true, recordInputs: false, recordOutputs: false };

let exporter: InMemorySpanExporter;
let manager: AsyncLocalStorageContextManager;
let tracing: AgentRun;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  manager = new AsyncLocalStorageContextManager().enable();
  apiContext.setGlobalContextManager(manager);
  tracing = createAgentRun({ telemetry: otelTelemetry({ provider }) });
});

afterEach(async () => {
  apiContext.disable();
  manager.disable();
  await tracing.shutdown();
});

describe("recordMemoryToolStore", () => {
  it("names the memory store on the tool span the call runs in, without content capture", async () => {
    const turn = await tracing.turn({ agentName: "support", identity, sequence: 0, capture });
    const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
    const tool = await attempt.tool({ callId: "call-1", name: "profile__save" });

    await tool.run(async () => recordMemoryToolStore("memscope1_alice", "profile"));
    await tool.complete();
    await attempt.complete();
    await turn.complete();

    const span = exporter.getFinishedSpans().find((next) => next.name.includes("profile__save"));
    expect(span?.attributes).toMatchObject({
      "agent.memory.slot": "profile",
      "gen_ai.memory.store.id": "memscope1_alice",
    });
  });

  it("does nothing outside a traced tool call", () => {
    expect(() => recordMemoryToolStore("memscope1_alice", "profile")).not.toThrow();
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});
