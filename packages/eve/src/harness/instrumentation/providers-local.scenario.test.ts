import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  finalizeInstrumentationProviders,
  getInstrumentationProviders,
  registerInstrumentationProvider,
  seedInstrumentationProviders,
} from "#harness/instrumentation/providers.js";
import { DEVELOPMENT_WORKER_APP_ROOT_ENV } from "#internal/workflow/development-world-protocol.js";
import { otelIntegration } from "#public/instrumentation/otel.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("instrumentation provider local default", () => {
  it("registers default local traces and an authored destination in one pipeline", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-provider-local-"));
    temporaryDirectories.push(appRoot);
    vi.stubEnv(DEVELOPMENT_WORKER_APP_ROOT_ENV, appRoot);
    vi.stubEnv("EVE_TRACES", "off");

    seedInstrumentationProviders();
    await registerInstrumentationProvider({
      agentName: "weather",
      slot: "backend",
      value: otelIntegration(),
    });

    const runtime = finalizeInstrumentationProviders({ serviceName: "weather" });
    await runtime.forceFlush();
    await runtime.shutdown();

    expect(getInstrumentationProviders().map(({ slot }) => slot)).toEqual(["backend", "local"]);
  });
});
