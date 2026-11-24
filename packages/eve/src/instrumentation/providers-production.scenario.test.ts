import { afterEach, describe, expect, it, vi } from "vitest";

import {
  finalizeInstrumentationProviders,
  getInstrumentationProviders,
  registerInstrumentationProvider,
  seedInstrumentationProviders,
} from "#instrumentation/providers.js";
import { localTraces } from "#public/instrumentation/otel.js";
import { createEntities } from "#platform/entities.js";
import vercelPlatform from "#platform/vercel/declaration.js";

const platform = createEntities(vercelPlatform, undefined);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("instrumentation provider production defaults", () => {
  it("keeps authored local traces inert beside Agent Runs", async () => {
    vi.stubEnv("EVE_DEV_WORKER_APP_ROOT", undefined);
    vi.stubEnv("VERCEL_ENV", "production");

    seedInstrumentationProviders(platform);
    await registerInstrumentationProvider({
      agentName: "weather",
      platform,
      slot: "local",
      value: localTraces(),
    });

    const runtime = finalizeInstrumentationProviders({ platform, serviceName: "weather" });
    await runtime.forceFlush();
    await runtime.shutdown();

    expect(getInstrumentationProviders().map(({ slot }) => slot)).toEqual(["agent-runs", "local"]);
  });
});
