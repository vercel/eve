import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  createAgentRun,
  otelTelemetry,
  type AgentRun,
  type DecisionInput,
} from "@vercel/agent-runs";

const identity = { conversationId: "alice-conversation", runId: "alice-run", turnId: "turn-1" };
const capture = { emit: true, recordInputs: false, recordOutputs: false };

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let manager: AsyncLocalStorageContextManager;
let tracing: AgentRun;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
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
const host = () => provider.getTracer("host");

describe("decision tracing", () => {
  it.each([
    { scenario: "the active operation", expected: "execute_tool classify" },
    { scenario: "a host span inside the operation", expected: "classify request" },
    { scenario: "the fallback parent over another trace's span", expected: "invoke_agent support" },
    { scenario: "a host span outside any run", expected: "script" },
  ])("parents a decision to $scenario", async ({ scenario, expected }) => {
    const turn = await tracing.turn({ agentName: "support", identity, sequence: 0, capture });
    const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
    const tool = await attempt.tool({ callId: "call-1", name: "classify" });
    const decide = (data: Partial<DecisionInput> = {}) =>
      tracing.decision(
        { modelId: "jev", provider: "typesafe-ai", agentName: "support", ...data },
        async (operation) => {
          await operation.complete({ usage: { inputTokens: 42, outputTokens: 3 } });
        },
      );
    if (scenario === "the active operation") await tool.run(() => decide({ identity }));
    if (scenario === "a host span inside the operation")
      await tool.run(() =>
        host().startActiveSpan("classify request", async (request) => {
          await decide({ identity });
          request.end();
        }),
      );
    if (scenario === "the fallback parent over another trace's span")
      await host().startActiveSpan("workflow step", { root: true }, async (step) => {
        await decide({ identity, parent: turn.reference });
        step.end();
      });
    if (scenario === "a host span outside any run")
      await host().startActiveSpan("script", { root: true }, async (script) => {
        await decide();
        script.end();
      });
    await tool.complete();
    await attempt.complete();
    await turn.complete();

    const decision = span("decision jev");
    expect(decision.parentSpanContext?.spanId).toBe(span(expected).spanContext().spanId);
    expect(decision.spanContext().traceId).toBe(span(expected).spanContext().traceId);
    expect(decision.attributes).toMatchObject({
      "gen_ai.operation.name": "decision",
      "gen_ai.provider.name": "typesafe-ai",
      "gen_ai.request.model": "jev",
      "gen_ai.usage.input_tokens": 42,
      "gen_ai.usage.output_tokens": 3,
    });
    expect(decision.attributes["agent.run.id"]).toBe(
      scenario === "a host span outside any run" ? undefined : "alice-run",
    );
  });

  it("records nothing beneath an unsampled parent", async () => {
    let inner: boolean | undefined;
    await tracing.decision(
      {
        modelId: "jev",
        identity,
        parent: { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 0 },
      },
      () => {
        const request = host().startSpan("decision request");
        inner = request.isRecording();
        request.end();
      },
    );
    expect(inner).toBe(false);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
