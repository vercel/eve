import type { LogWarningsFunction } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureAiSdkWarningLogger } from "#instrumentation/ai-sdk-warnings.js";
import { setLogRecordSubscriber, type LogRecord } from "#internal/logging.js";

describe("ensureAiSdkWarningLogger", () => {
  const originalLogger = globalThis.AI_SDK_LOG_WARNINGS;
  const originalEnvironmentValue = process.env.AI_SDK_LOG_WARNINGS;

  afterEach(() => {
    globalThis.AI_SDK_LOG_WARNINGS = originalLogger;
    setLogRecordSubscriber(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (originalEnvironmentValue === undefined) {
      delete process.env.AI_SDK_LOG_WARNINGS;
    } else {
      process.env.AI_SDK_LOG_WARNINGS = originalEnvironmentValue;
    }
  });

  it("preserves an application-defined warning logger", () => {
    const applicationLogger: LogWarningsFunction = vi.fn();
    globalThis.AI_SDK_LOG_WARNINGS = applicationLogger;

    ensureAiSdkWarningLogger();

    expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(applicationLogger);
  });

  it("preserves an application-defined false value", () => {
    globalThis.AI_SDK_LOG_WARNINGS = false;

    ensureAiSdkWarningLogger();

    expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(false);
  });

  it("translates AI_SDK_LOG_WARNINGS=false to the SDK global", () => {
    globalThis.AI_SDK_LOG_WARNINGS = undefined;
    vi.stubEnv("AI_SDK_LOG_WARNINGS", "false");

    ensureAiSdkWarningLogger();

    expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(false);
  });

  it("installs one idempotent warning logger", () => {
    globalThis.AI_SDK_LOG_WARNINGS = undefined;
    vi.stubEnv("AI_SDK_LOG_WARNINGS", "true");

    ensureAiSdkWarningLogger();
    const installedLogger = globalThis.AI_SDK_LOG_WARNINGS;
    ensureAiSdkWarningLogger();

    expect(installedLogger).toBeTypeOf("function");
    expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(installedLogger);
  });

  it("records compatibility warnings as structured info instead of stderr", () => {
    const records: LogRecord[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.AI_SDK_LOG_WARNINGS = undefined;
    vi.stubEnv("AI_SDK_LOG_WARNINGS", "true");
    setLogRecordSubscriber((record) => records.push(record));

    ensureAiSdkWarningLogger();
    const logger = globalThis.AI_SDK_LOG_WARNINGS as LogWarningsFunction | false | undefined;
    if (typeof logger !== "function") {
      throw new Error("Expected eve to install an AI SDK warning logger");
    }
    logger({
      model: "openai/gpt-5",
      provider: "gateway",
      warnings: [
        {
          type: "compatibility",
          feature: "JSON Schema propertyNames",
          details: "The provider removed it before sending the request.",
        },
      ],
    });

    expect(records).toEqual([
      {
        level: "info",
        namespace: "harness.ai-sdk-warnings",
        message: "AI SDK warning",
        fields: {
          model: "openai/gpt-5",
          provider: "gateway",
          warning: {
            type: "compatibility",
            feature: "JSON Schema propertyNames",
            details: "The provider removed it before sending the request.",
          },
        },
      },
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    {
      type: "unsupported" as const,
      feature: "temperature",
      details: "The provider ignored it.",
    },
    {
      type: "deprecated" as const,
      setting: "providerOptions.legacy",
      message: "Use providerOptions.current instead.",
    },
    {
      type: "other" as const,
      message: "The provider returned an actionable warning.",
    },
  ])("records $type warnings at warning level", (warning) => {
    const records: LogRecord[] = [];
    globalThis.AI_SDK_LOG_WARNINGS = undefined;
    vi.stubEnv("AI_SDK_LOG_WARNINGS", "true");
    setLogRecordSubscriber((record) => records.push(record));

    ensureAiSdkWarningLogger();
    const logger = globalThis.AI_SDK_LOG_WARNINGS as LogWarningsFunction | false | undefined;
    if (typeof logger !== "function") {
      throw new Error("Expected eve to install an AI SDK warning logger");
    }
    logger({
      model: "openai/gpt-5",
      provider: "gateway",
      warnings: [warning],
    });

    expect(records).toEqual([
      {
        level: "warn",
        namespace: "harness.ai-sdk-warnings",
        message: "AI SDK warning",
        fields: {
          model: "openai/gpt-5",
          provider: "gateway",
          warning,
        },
      },
    ]);
  });
});
