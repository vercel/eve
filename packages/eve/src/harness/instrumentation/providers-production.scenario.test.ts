import { afterEach, describe, expect, it, vi } from "vitest";

import { getInstrumentationProviders } from "#harness/instrumentation/providers.js";
import { installCompiledInstrumentationPlan } from "#internal/instrumentation-plan-runtime.js";
import { agentRuns, localTraces } from "#public/instrumentation/otel.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("instrumentation provider production defaults", () => {
  it("keeps authored local traces inert beside Agent Runs", async () => {
    vi.stubEnv("EVE_DEV_WORKER_APP_ROOT", undefined);
    vi.stubEnv("VERCEL_ENV", "production");

    const shutdown = await installCompiledInstrumentationPlan({
      appRoot: "/virtual/weather",
      async loadModule(sourceId) {
        return { default: sourceId === "framework-agent-runs" ? agentRuns() : localTraces() };
      },
      mode: "production",
      plan: {
        entries: [
          {
            activation: "production",
            implementation: "provider",
            slot: "agent-runs",
            source: {
              logicalPath: "instrumentation/agent-runs.ts",
              sourceId: "framework-agent-runs",
              sourceKind: "module",
            },
          },
          {
            activation: "always",
            implementation: "provider",
            slot: "local",
            source: {
              logicalPath: "instrumentation/local.ts",
              sourceId: "authored-local",
              sourceKind: "module",
            },
          },
        ],
        kind: "providers",
      },
      serviceName: "weather",
    });
    await shutdown();

    expect(getInstrumentationProviders().map(({ slot }) => slot)).toEqual(["agent-runs", "local"]);
  });
});
