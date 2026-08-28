import { OpenTelemetry } from "#compiled/@ai-sdk/otel/index.js";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Telemetry } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("#internal/logging.js", () => ({
  createLogger: () => ({ warn: logWarn }),
}));

import {
  ensureOtelIntegration,
  getRegisteredTelemetryIntegrations,
  telemetryWithoutErrorContent,
} from "#harness/ai-sdk-telemetry.js";

describe("getRegisteredTelemetryIntegrations", () => {
  const original = globalThis.AI_SDK_TELEMETRY_INTEGRATIONS;

  afterEach(() => {
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = original;
    logWarn.mockClear();
  });

  it("is empty when nothing has registered", () => {
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
    expect(getRegisteredTelemetryIntegrations()).toEqual([]);
  });

  it("reports the integrations in registration order", () => {
    const first: Telemetry = { onStart() {} };
    const second: Telemetry = { onStart() {} };
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = [first, second];

    expect(getRegisteredTelemetryIntegrations()).toEqual([first, second]);
  });

  it("warns once when eve's integration cannot be identity-matched", () => {
    const foreign: Telemetry = { onStart() {} };
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = [foreign];

    expect(getRegisteredTelemetryIntegrations({ sanitizeEveOtelErrors: true })).toEqual([foreign]);
    expect(getRegisteredTelemetryIntegrations({ sanitizeEveOtelErrors: true })).toEqual([foreign]);
    expect(logWarn).toHaveBeenCalledOnce();
  });

  it("replaces only eve's OTel integration in error-safe mode", () => {
    const authored: Telemetry = { onStart() {} };
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = [];
    ensureOtelIntegration();
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS.push(authored);

    const registered = getRegisteredTelemetryIntegrations();
    const errorSafe = getRegisteredTelemetryIntegrations({ sanitizeEveOtelErrors: true });
    expect(errorSafe).toHaveLength(2);
    expect(errorSafe[0]).not.toBe(registered[0]);
    expect(errorSafe[1]).toBe(authored);
  });
});

describe("telemetryWithoutErrorContent", () => {
  it("replaces operation and tool errors without changing correlation", async () => {
    const onError = vi.fn();
    const onToolExecutionEnd = vi.fn();
    const telemetry = telemetryWithoutErrorContent({ onError, onToolExecutionEnd });

    await telemetry.onError?.({ callId: "call-1", error: new Error("private response body") });
    await telemetry.onToolExecutionEnd?.({
      callId: "call-1",
      messages: [],
      toolCall: { input: {}, toolCallId: "tool-1", toolName: "weather", type: "tool-call" },
      toolContext: undefined,
      toolExecutionMs: 1,
      toolOutput: {
        error: new Error("private tool output"),
        input: {},
        toolCallId: "tool-1",
        toolName: "weather",
        type: "tool-error",
      },
    });

    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      callId: "call-1",
      error: expect.objectContaining({ message: "AI SDK operation failed" }),
    });
    expect(onToolExecutionEnd.mock.calls[0]?.[0]).toMatchObject({
      callId: "call-1",
      toolOutput: {
        error: expect.objectContaining({ message: "AI SDK operation failed" }),
        type: "tool-error",
      },
    });
  });

  it("keeps sentinel errors out of real OpenTelemetry spans", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const telemetry = telemetryWithoutErrorContent(
      new OpenTelemetry({ tracer: provider.getTracer("test") }),
    );
    const callId = "call-1";
    const error = new Error("SECRET-ERROR-BODY");

    await Reflect.apply(telemetry.onStart!, telemetry, [
      {
        callId,
        messages: [],
        modelId: "test-model",
        operationId: "ai.streamText",
        provider: "test-provider",
        recordInputs: false,
        recordOutputs: false,
      },
    ]);
    await Reflect.apply(telemetry.onToolExecutionStart!, telemetry, [
      {
        callId,
        toolCall: { input: {}, toolCallId: "tool-1", toolName: "weather" },
      },
    ]);
    await Reflect.apply(telemetry.onToolExecutionEnd!, telemetry, [
      {
        callId,
        messages: [],
        toolCall: { input: {}, toolCallId: "tool-1", toolName: "weather" },
        toolExecutionMs: 1,
        toolOutput: { error, type: "tool-error" },
      },
    ]);
    await Reflect.apply(telemetry.onError!, telemetry, [{ callId, error }]);
    await provider.forceFlush();

    const exported = JSON.stringify(
      exporter.getFinishedSpans().map((span) => ({
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    );
    expect(exported).not.toContain("SECRET-ERROR-BODY");
    expect(exported).toContain("AI SDK operation failed");
    await provider.shutdown();
  });
});
