import type { Telemetry } from "ai";
import { afterEach, describe, expect, it } from "vitest";

import { getRegisteredTelemetryIntegrations } from "#harness/ai-sdk-telemetry.js";

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
});
