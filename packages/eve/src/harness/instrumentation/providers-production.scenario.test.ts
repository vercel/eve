import { afterEach, describe, expect, it, vi } from "vitest";

import {
  finalizeInstrumentationProviders,
  getInstrumentationProviders,
  registerInstrumentationProvider,
  seedInstrumentationProviders,
} from "#harness/instrumentation/providers.js";
import { localTraces } from "#public/instrumentation/otel.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("instrumentation provider production defaults", () => {
  it("keeps authored local traces inert beside Agent Runs", async () => {
    vi.stubEnv("EVE_DEV_WORKER_APP_ROOT", undefined);
    vi.stubEnv("VERCEL_ENV", "production");

    seedInstrumentationProviders();
    await registerInstrumentationProvider({
      agentName: "weather",
      slot: "local",
      value: localTraces(),
    });

    const runtime = finalizeInstrumentationProviders({ serviceName: "weather" });
    await runtime.forceFlush();
    await runtime.shutdown();

    expect(getInstrumentationProviders().map(({ slot }) => slot)).toEqual(["agent-runs", "local"]);
  });
});
