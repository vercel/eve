import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InstrumentationSetupContext } from "#public/instrumentation/index.js";

const RUNTIME_GLOBAL_KEY = Symbol.for("eve.instrumentation-runtime");

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[RUNTIME_GLOBAL_KEY];
});

describe("instrumentation config runtime registration", () => {
  it("exposes a resolver registered in one module evaluation through the shared runtime", async () => {
    vi.resetModules();
    const moduleA = await import("#instrumentation/config.js");
    const resolver = vi.fn(() => ({ runtimeContext: { team: "platform" } }));
    await moduleA.registerInstrumentationConfig(
      { events: { "step.started": resolver } },
      { agentName: "test-agent" },
    );

    vi.resetModules();
    const moduleB = await import("#instrumentation/runtime.js");

    expect(
      moduleB.getInstrumentationRuntime()?.stepStartedRuntimeContextResolver?.({} as never),
    ).toEqual({ runtimeContext: { team: "platform" } });
    expect(resolver).toHaveBeenCalledOnce();
  });

  it("replaces the resolver when the authored config reloads", async () => {
    const { registerInstrumentationConfig } = await import("#instrumentation/config.js");
    const { getInstrumentationRuntime } = await import("#instrumentation/runtime.js");
    const first = vi.fn(() => ({ runtimeContext: { version: 1 } }));
    const second = vi.fn(() => ({ runtimeContext: { version: 2 } }));

    await registerInstrumentationConfig(
      { events: { "step.started": first } },
      { agentName: "test-agent" },
    );
    await registerInstrumentationConfig(
      { events: { "step.started": second } },
      { agentName: "test-agent" },
    );

    expect(getInstrumentationRuntime()?.stepStartedRuntimeContextResolver?.({} as never)).toEqual({
      runtimeContext: { version: 2 },
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("installs harness telemetry settings on the instrumentation runtime", async () => {
    const { registerInstrumentationConfig } = await import("#instrumentation/config.js");
    const { getInstrumentationRuntime } = await import("#instrumentation/runtime.js");

    await registerInstrumentationConfig(
      {
        functionId: "weather",
        recordInputs: true,
        recordOutputs: false,
        traceChannelRequests: true,
      },
      { agentName: "test-agent" },
    );

    expect(getInstrumentationRuntime()?.otelSettings).toEqual({
      functionId: "weather",
      recordInputs: true,
      recordOutputs: false,
      traceChannelRequests: true,
    });
  });

  it("disables input and output recording by default", async () => {
    const { registerInstrumentationConfig } = await import("#instrumentation/config.js");
    const { getInstrumentationRuntime } = await import("#instrumentation/runtime.js");

    await registerInstrumentationConfig({}, { agentName: "test-agent" });

    expect(getInstrumentationRuntime()?.otelSettings).toEqual({
      functionId: undefined,
      recordInputs: false,
      recordOutputs: false,
      traceChannelRequests: false,
    });
  });

  it("awaits the setup callback with the resolved context", async () => {
    vi.resetModules();
    const { registerInstrumentationConfig } = await import("#instrumentation/config.js");

    const contexts: InstrumentationSetupContext[] = [];
    await registerInstrumentationConfig(
      {
        setup: (context) => {
          contexts.push(context);
        },
      },
      { agentName: "weather-agent" },
    );

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.agentName).toBe("weather-agent");
    expect(contexts[0]?.environment).toMatch(/^(development|production)$/);
    expect(contexts[0]?.frameworkVersion).toEqual(expect.any(String));
  });
});
