import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InstrumentationSetupContext } from "#public/instrumentation/index.js";

const RUNTIME_GLOBAL_KEY = Symbol.for("eve.instrumentation-runtime");

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[RUNTIME_GLOBAL_KEY];
});

/**
 * Regression coverage for the instrumentation-config chunk-isolation failure.
 *
 * `eve dev` (Nitro) evaluates `instrumentation-config.ts` twice: once via the
 * generated instrumentation plugin (kept external by `file://` URL) and once
 * via the bundled harness chunk (inlined via the `#harness/*` import alias).
 * Each evaluation gets its own module loader, so any module-scoped state
 * lived in two separate bindings — a config registered by the plugin was
 * invisible to the harness one turn later, and `getInstrumentationConfig()`
 * silently returned `undefined` even when `defineInstrumentation` was set up.
 *
 * The fix mounts the config on `globalThis` under a stable `Symbol.for(...)`
 * so every module copy resolves the same slot, mirroring the established
 * patterns for the context-key registry (`context/key.ts`) and the
 * runtime-session storage (`runtime/sessions/runtime-session.ts`).
 *
 * These tests reproduce the failure by using `vi.resetModules()` to force
 * a fresh evaluation of `instrumentation-config.ts`, simulating two separate
 * module loaders holding their own copies of the file.
 */
describe("instrumentation-config chunk-isolation regression", () => {
  it("a config registered in one module evaluation is visible from another", async () => {
    vi.resetModules();
    const moduleA = await import("#harness/instrumentation/config.js");
    const config = { functionId: "test.instrumentation.cross-module.alice" };
    await moduleA.registerInstrumentationConfig(config, { agentName: "test-agent" });

    vi.resetModules();
    const moduleB = await import("#harness/instrumentation/config.js");

    // Pre-fix: moduleB's `registeredConfig` is a fresh `undefined` binding.
    // Post-fix: both evaluations share one globalThis-mounted slot.
    expect(moduleB.getInstrumentationConfig()).toBe(config);
  });

  it("the config is mounted on globalThis under the canonical symbol", async () => {
    const globalKey = Symbol.for("eve.harness-instrumentation-config");
    const { registerInstrumentationConfig } = await import("#harness/instrumentation/config.js");

    const canary = { functionId: "test.instrumentation.global-mount.canary" };
    await registerInstrumentationConfig(canary, { agentName: "test-agent" });

    expect((globalThis as Record<symbol, unknown>)[globalKey]).toBe(canary);
  });

  it("re-importing reuses the same globalThis slot", async () => {
    const globalKey = Symbol.for("eve.harness-instrumentation-config");

    vi.resetModules();
    const moduleA = await import("#harness/instrumentation/config.js");
    const config = { functionId: "test.instrumentation.reimport.canary" };
    await moduleA.registerInstrumentationConfig(config, { agentName: "test-agent" });
    const firstRef = (globalThis as Record<symbol, unknown>)[globalKey];

    vi.resetModules();
    await import("#harness/instrumentation/config.js");
    const secondRef = (globalThis as Record<symbol, unknown>)[globalKey];

    expect(secondRef).toBe(firstRef);
  });

  it("installs harness telemetry settings on the instrumentation runtime", async () => {
    const { registerInstrumentationConfig } = await import("#harness/instrumentation/config.js");
    const { getInstrumentationRuntime } = await import("#harness/instrumentation/runtime.js");

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

  it("awaits the setup callback with the resolved context", async () => {
    vi.resetModules();
    const { registerInstrumentationConfig } = await import("#harness/instrumentation/config.js");

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
