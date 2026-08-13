import { beforeEach, describe, expect, it, vi } from "vitest";

import { turnIdempotencyKey } from "#harness/instrumentation/lifecycle.js";
import {
  EVE_EVALUATION_ENV_FLAG,
  EVE_EVALUATION_RUN_ID_ENV,
} from "#internal/application/dev-environment.js";
import {
  finalizeInstrumentationProviders,
  getInstrumentationProviders,
  registerInstrumentationProvider,
  seedInstrumentationProviders,
  shutdownInstrumentationProviders,
} from "#harness/instrumentation/providers.js";
import { DEVELOPMENT_WORKER_APP_ROOT_ENV } from "#internal/workflow/development-world-protocol.js";
import { defineInstrumentation } from "#public/instrumentation/index.js";
import { agentRuns, localTraces, otelIntegration } from "#public/instrumentation/otel.js";
import {
  disableInstrumentation,
  type ProviderSetupContext,
} from "#public/instrumentation/provider.js";

const REGISTRY_GLOBAL_KEY = Symbol.for("eve.harness-instrumentation-providers");
const RUNTIME_GLOBAL_KEY = Symbol.for("eve.instrumentation-runtime");

function register(slot: string, value: unknown): Promise<void> {
  return registerInstrumentationProvider({ agentName: "weather-agent", slot, value });
}

describe("registerInstrumentationProvider", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as Record<symbol, unknown>)[REGISTRY_GLOBAL_KEY];
    delete (globalThis as Record<symbol, unknown>)[RUNTIME_GLOBAL_KEY];
  });

  it("registers a provider under its slot", async () => {
    const provider = defineInstrumentation({ events: {} });
    await register("otel", provider);

    expect(getInstrumentationProviders()).toEqual([{ provider, slot: "otel" }]);
  });

  it("preserves registration order across slots", async () => {
    await register("agent-runs", defineInstrumentation({}));
    await register("local", defineInstrumentation({}));

    expect(getInstrumentationProviders().map(({ slot }) => slot)).toEqual(["agent-runs", "local"]);
  });

  it("awaits setup with the resolved provider context", async () => {
    const contexts: ProviderSetupContext[] = [];
    await register(
      "otel",
      defineInstrumentation({
        setup: (context) => {
          contexts.push(context);
        },
        shutdown: () => {},
      }),
    );

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.agentName).toBe("weather-agent");
    expect(contexts[0]?.environment).toMatch(/^(development|preview|production)$/);
    expect(contexts[0]?.evaluation).toBeUndefined();
    expect(contexts[0]?.frameworkVersion).toEqual(expect.any(String));
  });

  it("reports Vercel preview separately from production", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const contexts: ProviderSetupContext[] = [];

    await register(
      "otel",
      defineInstrumentation({ setup: (context) => void contexts.push(context) }),
    );

    expect(contexts[0]?.environment).toBe("preview");
  });

  it("reports an evaluation server to setup", async () => {
    vi.stubEnv(EVE_EVALUATION_ENV_FLAG, "1");
    vi.stubEnv(EVE_EVALUATION_RUN_ID_ENV, "eval-run-1");

    const contexts: ProviderSetupContext[] = [];
    await register(
      "otel",
      defineInstrumentation({
        setup: (context) => {
          contexts.push(context);
        },
      }),
    );

    expect(contexts[0]?.evaluation).toEqual({ runId: "eval-run-1" });
  });

  it("registers nothing for a disabled slot", async () => {
    await register("local", disableInstrumentation());

    expect(getInstrumentationProviders()).toEqual([]);
  });

  it("removes an already-registered provider when a later file disables the slot", async () => {
    await register("local", defineInstrumentation({}));
    await register("local", disableInstrumentation());

    expect(getInstrumentationProviders()).toEqual([]);
  });

  // A slot that registers nothing is telemetry that silently does nothing —
  // the failure this surface exists to prevent — so the shape check throws
  // rather than skipping the file.
  it.each([
    ["a bare object", { events: {} }],
    ["a function", () => {}],
    ["undefined", undefined],
    ["null", null],
  ])("throws when the default export is %s", async (_label, value) => {
    await expect(register("otel", value)).rejects.toThrow(
      /The default export of "instrumentation\/otel" is not an instrumentation provider/,
    );
  });
});

describe("seedInstrumentationProviders", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as Record<symbol, unknown>)[REGISTRY_GLOBAL_KEY];
    delete (globalThis as Record<symbol, unknown>)[RUNTIME_GLOBAL_KEY];
    vi.stubEnv("EVE_TRACES", "off");
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv(DEVELOPMENT_WORKER_APP_ROOT_ENV, "/tmp/eve-seed-test");
  });

  it("sorts default local traces with authored destinations", async () => {
    seedInstrumentationProviders();
    await register("backend", otelIntegration());

    expect(getInstrumentationProviders().map(({ slot }) => slot)).toEqual(["backend", "local"]);
  });

  it("seeds Agent Runs only in Vercel production", () => {
    vi.stubEnv(DEVELOPMENT_WORKER_APP_ROOT_ENV, undefined);
    vi.stubEnv("VERCEL_ENV", "production");

    seedInstrumentationProviders();

    expect(getInstrumentationProviders().map(({ slot }) => slot)).toEqual(["agent-runs"]);
  });

  it("lets an authored reserved slot reconfigure or disable its default", async () => {
    seedInstrumentationProviders();
    const authored = localTraces({ recordInputs: false });
    await register("local", authored);
    expect(getInstrumentationProviders()).toEqual([{ provider: authored, slot: "local" }]);

    await register("local", disableInstrumentation());
    expect(getInstrumentationProviders()).toEqual([]);
  });

  it("lets an authored Agent Runs slot narrow the production default", async () => {
    vi.stubEnv(DEVELOPMENT_WORKER_APP_ROOT_ENV, undefined);
    vi.stubEnv("VERCEL_ENV", "production");
    seedInstrumentationProviders();
    const authored = agentRuns({ recordOutputs: false });

    await register("agent-runs", authored);

    expect(getInstrumentationProviders()).toEqual([{ provider: authored, slot: "agent-runs" }]);
  });

  it("sorts built-ins, authored slots, and reserved-slot replacements together", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    seedInstrumentationProviders();
    await register("zeta", defineInstrumentation({}));
    await register("audit", defineInstrumentation({}));
    await register("local", localTraces({ recordInputs: false }));

    expect(getInstrumentationProviders().map(({ slot }) => slot)).toEqual([
      "agent-runs",
      "audit",
      "local",
      "zeta",
    ]);
  });
});

describe("finalizeInstrumentationProviders", () => {
  const turnStarted = {
    idempotencyKey: turnIdempotencyKey("session-1", "turn-1"),
    rootSessionId: "session-1",
    sequence: 0,
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.started",
  } as const;

  beforeEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as Record<symbol, unknown>)[REGISTRY_GLOBAL_KEY];
    delete (globalThis as Record<symbol, unknown>)[RUNTIME_GLOBAL_KEY];
  });

  it("publishes to an authored handler", async () => {
    const started = vi.fn();
    await register("rows", defineInstrumentation({ events: { "turn.started": started } }));

    const runtime = finalizeInstrumentationProviders({ serviceName: "weather-agent" });
    await runtime.hooks.publish(turnStarted);

    expect(started).toHaveBeenCalledOnce();
    expect(started.mock.calls[0]?.[0]).toMatchObject({ turnId: "turn-1" });
  });

  it("still runs execution when no destination was declared", async () => {
    // A directory with no `otel()` has nothing to hang a span on, so
    // `runInContext` degrades to running the work directly rather than
    // going missing.
    await register("rows", defineInstrumentation({}));

    const runtime = finalizeInstrumentationProviders({ serviceName: "weather-agent" });
    const result = await runtime.runInContext(
      {
        idempotencyKey: "tool:session-1:turn-1:0:0:call-1:0",
        scope: {
          attemptId: "session-1:turn-1:0:0",
          attemptIndex: 0,
          sessionId: "session-1",
          stepIndex: 0,
          turnId: "turn-1",
        },
        type: "tool.call",
      },
      () => Promise.resolve("ran"),
    );

    expect(result).toBe("ran");
  });

  it("drains and releases every provider", async () => {
    const flush = vi.fn();
    const shutdown = vi.fn();
    await register("rows", defineInstrumentation({ flush, shutdown }));

    const runtime = finalizeInstrumentationProviders({ serviceName: "weather-agent" });
    await runtime.forceFlush();
    await shutdownInstrumentationProviders();
    await shutdownInstrumentationProviders();

    expect(flush).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
