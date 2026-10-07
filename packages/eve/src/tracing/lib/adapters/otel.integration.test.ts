import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { context, ROOT_CONTEXT, createContextKey } from "@opentelemetry/api";
import { otelTelemetry } from "./otel.js";
import { AgentSpanIdGenerator } from "./otel-ids.js";
import { createSpanWriter } from "../core/writer.js";

describe("OTel trace output", () => {
  it("preserves explicit host context at span start and activation", async () => {
    const key = createContextKey("host-audience");
    const host = ROOT_CONTEXT.setValue(key, "private");
    const exporter = new InMemorySpanExporter();
    let audience: unknown;
    const provider = new BasicTracerProvider({
      spanProcessors: [
        {
          onStart(_span, parent) {
            audience = parent.getValue(key);
          },
          onEnd() {},
          async forceFlush() {},
          async shutdown() {},
        },
        new SimpleSpanProcessor(exporter),
      ],
    });
    const manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
    try {
      const operation = createSpanWriter({
        telemetry: otelTelemetry({ provider }),
      }).start(
        {
          type: "channelRequest",
          operationId: "request",
          name: "agent.channel.request",
          kind: "SERVER",
          attributes: {},
        },
        { emit: true, recordInputs: false, recordOutputs: false },
        host,
      );
      expect(audience).toBe("private");
      operation.run(() => expect(context.active().getValue(key)).toBe("private"));
      operation.end();
      expect(exporter.getFinishedSpans()).toHaveLength(1);
    } finally {
      context.disable();
      manager.disable();
      await provider.shutdown();
    }
  });

  it("maps deferred spans and late updates without changing reserved identity", async () => {
    const exporter = new InMemorySpanExporter();
    const idGenerator = new AgentSpanIdGenerator();
    const provider = new BasicTracerProvider({
      idGenerator,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    try {
      const telemetry = otelTelemetry({ provider, idGenerator });
      const capture = { emit: true, recordInputs: false, recordOutputs: false };
      const span = {
        type: "activation" as const,
        operationId: "activation",
        name: "invoke_agent support",
        root: true,
        startTimeMs: 1000,
        attributes: { "agent.run.id": "run", "agent.trace.schema.version": 4 },
        links: [
          {
            context: { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 },
            relationship: "agent.dispatch" as const,
          },
        ],
      };
      const reference = {
        traceId: telemetry.ids!.traceId("activation"),
        spanId: telemetry.ids!.spanId("activation"),
        traceFlags: 1,
      };
      const engine = createSpanWriter({ telemetry });
      const childReference = { ...reference, spanId: telemetry.ids!.spanId("tool") };
      const child = engine.start(
        {
          type: "tool",
          operationId: "tool",
          name: "execute_tool lookup",
          parent: reference,
          attributes: span.attributes,
        },
        capture,
        undefined,
        childReference,
      );
      child.setAttribute("agent.connection.name", "catalog");
      child.end(2000);
      const root = engine.start(span, capture, undefined, reference);
      root.addEvent("turn.completed", undefined, 3000);
      root.end(3000);
      const recorded = exporter.getFinishedSpans();
      expect(recorded[0]!.spanContext().spanId).toBe(childReference.spanId);
      expect(recorded[0]!.parentSpanContext?.spanId).toBe(reference.spanId);
      expect(recorded[0]!.attributes).toMatchObject({
        "agent.connection.name": "catalog",
        "agent.trace.schema.version": 4,
      });
      expect(recorded[1]!.spanContext()).toMatchObject(reference);
      expect(recorded[1]!.links[0]!.attributes).toEqual({ "agent.link.type": "agent.dispatch" });
    } finally {
      await provider.shutdown();
    }
  });
});
