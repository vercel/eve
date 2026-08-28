import type { Telemetry } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureOtelIntegration,
  getRegisteredTelemetryIntegrations,
  telemetryWithoutErrorContent,
} from "#harness/ai-sdk-telemetry.js";

describe("getRegisteredTelemetryIntegrations", () => {
  const original = globalThis.AI_SDK_TELEMETRY_INTEGRATIONS;

  afterEach(() => {
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = original;
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

  it("replaces only eve's OTel integration in metadata-only mode", () => {
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
});
