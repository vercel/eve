import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getInstrumentationProviders } from "#harness/instrumentation/providers.js";
import { installCompiledInstrumentationPlan } from "#internal/instrumentation-plan-runtime.js";
import { localTraces, otelIntegration } from "#public/instrumentation/otel.js";

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
    vi.stubEnv("EVE_TRACES", "off");

    const shutdown = await installCompiledInstrumentationPlan({
      appRoot,
      async loadModule(sourceId) {
        return { default: sourceId === "framework-local" ? localTraces() : otelIntegration() };
      },
      mode: "development",
      plan: {
        entries: [
          {
            activation: "always",
            implementation: "provider",
            slot: "backend",
            source: {
              logicalPath: "instrumentation/backend.ts",
              sourceId: "authored-backend",
              sourceKind: "module",
            },
          },
          {
            activation: "development",
            implementation: "provider",
            slot: "local",
            source: {
              logicalPath: "instrumentation/local.ts",
              sourceId: "framework-local",
              sourceKind: "module",
            },
          },
        ],
        kind: "providers",
      },
      serviceName: "weather",
    });
    await shutdown();

    expect(getInstrumentationProviders().map(({ slot }) => slot)).toEqual(["backend", "local"]);
  });
});
