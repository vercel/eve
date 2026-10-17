import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context } from "@opentelemetry/api";
import { createAgentDelegationTransport } from "@vercel/agent-runs/delegation";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  AgentSpanIdGenerator,
  createAgentRun,
  otelTelemetry,
  type TraceCheckpointer,
} from "@vercel/agent-runs";

const identity = { conversationId: "conversation", runId: "run", turnId: "turn" };

function memoryCheckpointer() {
  const entries = new Map<string, string>();
  const checkpointer: TraceCheckpointer = {
    get: (key) => {
      const value = entries.get(key);
      return value === undefined ? undefined : JSON.parse(value);
    },
    set: (key, value) => void entries.set(key, JSON.stringify(value)),
    delete: (key) => void entries.delete(key),
  };
  return { checkpointer, entries };
}

function worker(checkpointer: TraceCheckpointer, exporter: InMemorySpanExporter) {
  const idGenerator = new AgentSpanIdGenerator();
  const provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return createAgentRun({
    telemetry: otelTelemetry({ provider, idGenerator }),
    checkpointer,
  });
}

describe("durable agent tracing", () => {
  it("continues a turn in a new worker by calling the same operations again", async () => {
    const { checkpointer, entries } = memoryCheckpointer();
    const exporter = new InMemorySpanExporter();

    const first = worker(checkpointer, exporter);
    const turn = await first.turn({ agentName: "support", identity, sequence: 0 });
    const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
    await attempt.modelCall({ provider: "test", modelId: "model" }, () => ({
      result: "call lookup",
      finishReason: "tool-calls",
      usage: { inputTokens: 3, outputTokens: 2 },
    }));
    const tool = await attempt.tool({ callId: "lookup", name: "lookup" });
    await tool.approval({ requestId: "approval" });
    expect(entries.size).toBe(1);

    // The first worker is lost while Alice reviews the approval.
    const second = worker(checkpointer, exporter);
    const resumedTurn = await second.turn({ agentName: "support", identity, sequence: 0 });
    const resumedAttempt = await resumedTurn.attempt({ stepIndex: 0, attempt: 0 });
    const resumedTool = await resumedAttempt.tool({ callId: "lookup", name: "lookup" });
    const approval = await resumedTool.approval({ requestId: "approval" });
    expect(resumedTurn.reference).toEqual(turn.reference);
    expect(resumedTool.reference).toEqual(tool.reference);

    await approval.complete({ outcome: "approved" });
    await resumedTool.complete({ outcome: "completed", output: "Alice's answer" });
    await resumedAttempt.complete();
    await resumedTurn.complete();
    await second.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual([
      "chat model",
      "agent.approval",
      "execute_tool lookup",
      "agent.step",
      "invoke_agent support",
    ]);
    const byName = new Map(spans.map((span) => [span.name, span]));
    const root = byName.get("invoke_agent support")!;
    expect(root.spanContext().spanId).toBe(turn.reference.spanId);
    expect(byName.get("agent.step")!.parentSpanContext?.spanId).toBe(turn.reference.spanId);
    expect(byName.get("agent.approval")!.attributes["agent.approval.outcome"]).toBe("approved");
    expect(root.attributes["gen_ai.usage.input_tokens"]).toBe(3);
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
    expect(entries.size).toBe(0);
  });

  it("keeps a tool call open after its attempt and the turn complete", async () => {
    const { checkpointer, entries } = memoryCheckpointer();
    const exporter = new InMemorySpanExporter();
    const first = worker(checkpointer, exporter);
    const turn = await first.turn({ agentName: "support", identity, sequence: 0 });
    const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
    const tool = await attempt.tool({ callId: "lookup", name: "lookup" });
    await tool.approval({ requestId: "approval" });
    await attempt.complete();
    await turn.complete();
    expect(entries.size).toBe(1);

    // Bob approves the request after the turn has parked.
    const second = worker(checkpointer, exporter);
    expect(await second.resume({ identity: { ...identity, turnId: "other" } })).toBeUndefined();
    const resumed = await second.resume({ identity });
    expect(resumed!.findAttempt({ stepIndex: 0, attempt: 0 })?.reference).toEqual(
      attempt.reference,
    );
    expect(resumed!.findTool("missing")).toBeUndefined();
    const resumedTool = resumed!.findTool("lookup")!;
    await resumedTool.findApproval("approval")!.complete({ outcome: "approved" });
    expect(resumedTool.findApproval("approval")).toBeUndefined();
    await resumedTool.complete();
    expect(resumed!.findTool("lookup")).toBeUndefined();
    await second.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual([
      "agent.step",
      "invoke_agent support",
      "agent.approval",
      "execute_tool lookup",
    ]);
    expect(spans[3]!.parentSpanContext?.spanId).toBe(attempt.reference.spanId);
    expect(entries.size).toBe(0);
  });

  it("merges a tool call reported twice into one span", async () => {
    const { checkpointer } = memoryCheckpointer();
    const exporter = new InMemorySpanExporter();
    const tracing = worker(checkpointer, exporter);
    const turn = await tracing.turn({ agentName: "support", identity, sequence: 0 });
    const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
    // The SDK runs the tool before the runtime records its dispatch.
    const requestedAt = Date.now() - 60_000;
    const executed = await attempt.tool({
      callId: "lookup",
      name: "lookup",
      startTimeMs: requestedAt + 1000,
    });
    const dispatched = await attempt.tool({
      callId: "lookup",
      name: "lookup",
      kind: "subagent-call",
      startTimeMs: requestedAt,
    });
    expect(dispatched.reference).toEqual(executed.reference);
    const nested = await dispatched.tool({ callId: "inner", name: "inner" });
    await nested.complete();
    await dispatched.complete({ outcome: "completed" });
    await attempt.complete();
    await turn.complete();
    await tracing.forceFlush();

    const spans = new Map(exporter.getFinishedSpans().map((span) => [span.name, span]));
    const tool = spans.get("execute_tool lookup")!;
    expect(tool.startTime[0] * 1000 + tool.startTime[1] / 1e6).toBeCloseTo(requestedAt, -1);
    expect(tool.attributes).toMatchObject({
      "agent.action.kind": "subagent-call",
      "agent.action.name": "lookup",
      "agent.action.outcome": "completed",
      "agent.invocation.role": "caller",
    });
    expect(spans.get("execute_tool inner")!.parentSpanContext?.spanId).toBe(
      tool.spanContext().spanId,
    );
  });

  it("adopts a reserved turn reference and applies sampling", async () => {
    const { checkpointer } = memoryCheckpointer();
    const exporter = new InMemorySpanExporter();
    const idGenerator = new AgentSpanIdGenerator();
    const tracing = createAgentRun({
      telemetry: otelTelemetry({
        provider: new BasicTracerProvider({
          idGenerator,
          spanProcessors: [new SimpleSpanProcessor(exporter)],
        }),
        idGenerator,
        samplesTrace: (traceId) => traceId !== "b".repeat(32),
      }),
      checkpointer,
    });
    const reference = { traceId: "a".repeat(32), spanId: "c".repeat(16), traceFlags: 1 };
    const turn = await tracing.turn({ agentName: "support", identity, sequence: 0, reference });
    expect(turn.reference).toMatchObject(reference);
    const dropped = await tracing.turn({
      agentName: "support",
      identity: { ...identity, turnId: "dropped" },
      sequence: 1,
      reference: { ...reference, traceId: "b".repeat(32) },
    });
    expect(dropped.reference.traceFlags).toBe(0);
  });

  it("starts a fresh turn when the checkpoint is unusable", async () => {
    const { checkpointer, entries } = memoryCheckpointer();
    const exporter = new InMemorySpanExporter();
    const errors: string[] = [];
    const idGenerator = new AgentSpanIdGenerator();
    const tracing = createAgentRun({
      telemetry: otelTelemetry({
        provider: new BasicTracerProvider({
          idGenerator,
          spanProcessors: [new SimpleSpanProcessor(exporter)],
        }),
        idGenerator,
      }),
      checkpointer: {
        ...checkpointer,
        get: () => ({ version: 1, key: "corrupt" }),
      },
      onError: (_error, context) => errors.push(context.phase),
    });
    const turn = await tracing.turn({ agentName: "support", identity, sequence: 0 });
    await turn.complete();
    expect(errors).toEqual(["restore"]);
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["invoke_agent support"]);
    expect(entries.size).toBe(0);
  });

  it("requires stable span IDs", () => {
    expect(() =>
      createAgentRun({
        telemetry: otelTelemetry({ provider: new BasicTracerProvider() }),
        checkpointer: memoryCheckpointer().checkpointer,
      }),
    ).toThrow(/AgentSpanIdGenerator/u);
  });
});

describe("content capture after a narrower decision", () => {
  const ALL = { emit: true, recordInputs: true, recordOutputs: true } as const;
  const NO_OUTPUTS = { emit: true, recordInputs: true, recordOutputs: false } as const;
  const NO_INPUTS = { emit: true, recordInputs: false, recordOutputs: true } as const;
  const METADATA = { emit: true, recordInputs: false, recordOutputs: false } as const;
  // Run ceilings reach nested work through the active context.
  beforeEach(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });
  afterEach(() => {
    context.disable();
  });

  async function setup() {
    const { checkpointer, entries } = memoryCheckpointer();
    const exporter = new InMemorySpanExporter();
    const tracing = worker(checkpointer, exporter);
    const turn = await tracing.turn({ agentName: "support", identity, sequence: 0, capture: ALL });
    const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
    const exported = async () => {
      await tracing.forceFlush();
      const spans = exporter
        .getFinishedSpans()
        .map((span) => ({ attributes: span.attributes, events: span.events }));
      return JSON.stringify(spans) + JSON.stringify([...entries.values()]);
    };
    return { tracing, turn, attempt, exported, checkpointer, entries, exporter };
  }

  it("keeps an existing tool's failure out when its parent's run declines outputs", async () => {
    const { turn, attempt, exported } = await setup();
    const tool = await attempt.tool({ callId: "lookup", name: "lookup" });
    await attempt.run(() => tool.fail(new Error("Alice's private note")), NO_OUTPUTS);
    await attempt.complete();
    await turn.complete();
    expect(await exported()).not.toContain("private note");
  });

  it("keeps an error recorded inside an output-declined run out", async () => {
    const { turn, attempt, exported } = await setup();
    const tool = await attempt.tool({ callId: "lookup", name: "lookup" });
    tool.run(() => tool.recordError(new Error("Alice's private note")), NO_OUTPUTS);
    await tool.complete();
    await attempt.complete();
    await turn.complete();
    expect(await exported()).not.toContain("private note");
  });

  it("drops arguments a second report adds inside an input-declined run", async () => {
    const { turn, attempt, exported } = await setup();
    const tool = await attempt.tool({ callId: "lookup", name: "lookup" });
    await attempt.run(
      () =>
        attempt.tool({ callId: "lookup", name: "lookup", arguments: { note: "Bob's address" } }),
      NO_INPUTS,
    );
    expect(await exported()).not.toContain("Bob's address");
    await tool.complete();
    await attempt.complete();
    await turn.complete();
    expect(await exported()).not.toContain("Bob's address");
  });

  it("holds an existing tool's result to its parent's narrower run", async () => {
    const { turn, attempt, exported } = await setup();
    const tool = await attempt.tool({ callId: "lookup", name: "lookup" });
    await attempt.run(() => tool.complete({ output: "Alice's private note" }), NO_OUTPUTS);
    await attempt.complete();
    await turn.complete();
    expect(await exported()).not.toContain("private note");
  });

  it("snapshots arguments accepted from a second tool report", async () => {
    const { turn, attempt, exported } = await setup();
    const tool = await attempt.tool({ callId: "lookup", name: "lookup" });
    const arguments_ = { note: { text: "Alice's approved note" } };
    await attempt.tool({ callId: "lookup", name: "lookup", arguments: arguments_ });
    attempt.run(() => {
      arguments_.note.text = "Alice's private note";
    }, NO_INPUTS);
    await attempt.tool({ callId: "lookup", name: "lookup" });
    const approval = await tool.approval({ requestId: "approval" });
    expect(await exported()).toContain("approved note");
    expect(await exported()).not.toContain("private note");
    await approval.complete();
    await tool.complete();
    await attempt.complete();
    await turn.complete();
    expect(await exported()).toContain("approved note");
    expect(await exported()).not.toContain("private note");
  });

  it.each(["Error", "object"] as const)(
    "snapshots a retained %s before later mutation",
    async (kind) => {
      const { turn, attempt, exported } = await setup();
      const tool = await attempt.tool({ callId: "lookup", name: "lookup" });
      const error =
        kind === "Error"
          ? new Error("Alice's approved note")
          : { message: "Alice's approved note" };
      tool.recordError(error);
      tool.run(() => {
        error.message = "Alice's private note";
        if (error instanceof Error) error.stack = "Alice's private stack";
      }, NO_OUTPUTS);
      const approval = await tool.approval({ requestId: "approval" });
      expect(await exported()).toContain("approved note");
      expect(await exported()).not.toContain("private");
      await approval.complete();
      await tool.complete();
      await attempt.complete();
      await turn.complete();
      expect(await exported()).toContain("approved note");
      expect(await exported()).not.toContain("private");
    },
  );

  it.each([
    ["cached", "turn"],
    ["restored", "turn"],
    ["cached", "resume"],
    ["restored", "resume"],
  ] as const)("honors a remote capture decline on a %s %s", async (state, entrypoint) => {
    const { tracing, turn, attempt, checkpointer, entries, exporter, exported } = await setup();
    const tool = await attempt.tool({ callId: "lookup", name: "lookup" });
    const receiver = state === "cached" ? tracing : worker(checkpointer, exporter);
    const transport = createAgentDelegationTransport();
    const headers = new Headers({
      "x-agent-tracing": JSON.stringify({
        caller: { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 },
        conversationId: identity.conversationId,
        parentRunId: "caller-run",
        parentCallId: "caller-call",
        agentName: "support",
        capture: METADATA,
      }),
    });
    const reentered = await transport.receive(
      headers,
      () => true,
      () =>
        entrypoint === "turn"
          ? receiver.turn({ agentName: "support", identity, sequence: 0, capture: ALL })
          : receiver.resume({ identity }),
    );
    expect(reentered!.reference).toEqual(turn.reference);
    const resumedAttempt = reentered!.findAttempt({ stepIndex: 0, attempt: 0 })!;
    const resumedTool = await resumedAttempt.tool({
      callId: "lookup",
      name: "lookup",
      arguments: { note: "Bob's private address" },
    });
    expect(resumedTool.reference).toEqual(tool.reference);
    const approval = await resumedTool.approval({ requestId: "approval" });
    expect(JSON.stringify([...entries.values()])).not.toContain("private address");
    await approval.complete({ response: "Alice's private response" });
    await resumedTool.complete({ output: "Alice's private result" });
    await resumedAttempt.complete();
    await reentered!.complete();
    await receiver.forceFlush();
    const output = await exported();
    expect(output).not.toContain("private");
    expect(exporter.getFinishedSpans().some((span) => span.name === "execute_tool lookup")).toBe(
      true,
    );
  });

  it("narrows a cached turn re-entered with less capture", async () => {
    const { tracing, exported } = await setup();
    const reentered = await tracing.turn({
      agentName: "support",
      identity,
      sequence: 0,
      capture: METADATA,
    });
    const attempt = reentered.findAttempt({ stepIndex: 0, attempt: 0 })!;
    await attempt.tool(
      {
        callId: "lookup",
        name: "lookup",
        arguments: { note: "Bob's address" },
        describe: (output: string) => ({ outcome: "completed", output }),
      },
      () => "Alice's private note",
    );
    await attempt.complete();
    await reentered.complete();
    const output = await exported();
    expect(output).not.toContain("Bob's address");
    expect(output).not.toContain("private note");
  });
});

describe("turn outcome", () => {
  it("ends a turn without an outcome when the host never learned one", async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = worker(memoryCheckpointer().checkpointer, exporter);
    const waiting = await tracing.turn({ agentName: "support", identity, sequence: 0 });
    await waiting.complete({ outcomeUnknown: true });
    const failed = await tracing.turn({
      agentName: "support",
      identity: { ...identity, turnId: "failed" },
      sequence: 1,
    });
    await failed.complete({ outcomeUnknown: true, failed: true });
    await tracing.forceFlush();

    const [first, second] = exporter.getFinishedSpans();
    expect(first!.attributes["agent.turn.outcome"]).toBeUndefined();
    expect(first!.events.map((event) => event.name)).toEqual(["turn.started"]);
    expect(second!.attributes["agent.turn.outcome"]).toBe("failed");
    expect(second!.events.map((event) => event.name)).toEqual(["turn.started", "turn.failed"]);
  });
});

describe("turn content", () => {
  it("records the first model input and the latest output on the turn", async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = worker(memoryCheckpointer().checkpointer, exporter);
    const all = { emit: true, recordInputs: true, recordOutputs: true };
    const turn = await tracing.turn({ agentName: "support", identity, sequence: 0, capture: all });
    for (const [stepIndex, prompt, answer] of [
      [0, "Alice asks for the forecast", "calling weather"],
      [1, "weather returned sunny", "It is sunny"],
    ] as const) {
      const attempt = await turn.attempt({ stepIndex, attempt: 0 });
      await attempt.modelCall(
        {
          provider: "test",
          modelId: "model",
          messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        },
        () => ({
          result: answer,
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
          content: [{ type: "text" as const, text: answer }],
        }),
      );
      await attempt.complete();
    }
    await turn.complete();
    await tracing.forceFlush();

    const spans = exporter.getFinishedSpans();
    const invocation = spans.find((span) => span.name === "invoke_agent support")!;
    expect(invocation.attributes["gen_ai.input.messages"]).toContain("Alice asks for the forecast");
    expect(invocation.attributes["gen_ai.input.messages"]).not.toContain("weather returned");
    expect(invocation.attributes["gen_ai.output.messages"]).toContain("It is sunny");
    expect(invocation.attributes["gen_ai.output.messages"]).not.toContain("calling weather");
    const step = spans.find((span) => span.name === "agent.step")!;
    expect(step.attributes).toMatchObject({
      "gen_ai.operation.name": "workflow",
      "operation.name": "workflow",
    });
  });

  it("leaves turn content out when capture declines it", async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = worker(memoryCheckpointer().checkpointer, exporter);
    const turn = await tracing.turn({ agentName: "support", identity, sequence: 0 });
    const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
    await attempt.modelCall(
      { provider: "test", modelId: "model", messages: [{ role: "user", content: "Alice" }] },
      () => ({
        result: "Bob",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
        content: [{ type: "text" as const, text: "Bob" }],
      }),
    );
    await attempt.complete();
    await turn.complete();
    await tracing.forceFlush();
    expect(JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes))).not.toMatch(
      /Alice|Bob/,
    );
  });
});
