import { afterEach, describe, expect, it } from "vitest";

import { ambientPlatform, appOf, bindApp, requireApp, runInApp } from "#context/app.js";
import { ContextContainer } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import { selectProcessPlatform } from "#platform/process.js";
import { testEntities, testPlatform } from "#internal/testing/test-platform.js";
import { createProcessApp, installProcessApp, type App } from "#runtime/app.js";

describe("the app in a turn's context", () => {
  it("stays out of the serialized context and across a step's context scope", () => {
    const app = { platform: {} } as App;
    const ctx = new ContextContainer();
    bindApp(ctx, app);

    expect(Object.keys(serializeContext(ctx))).not.toContain("eve.app");
    ctx.clearVirtualContext();
    expect(appOf(ctx)).toBe(app);
  });
});

describe("the app of a step", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  function startProcess(attempt: number | undefined): App {
    const process = createProcessApp();
    const app = { platform: {} } as App;
    process.started = app;
    Object.assign(process.hosts, { engine: { stepAttempt: () => attempt } });
    restore = installProcessApp(process);
    return app;
  }

  it("is the started app of the process when no context binds one", () => {
    const app = startProcess(1);
    expect(requireApp(new ContextContainer())).toBe(app);
    expect(requireApp(undefined)).toBe(app);
  });

  it("stays the bound app when the context binds one", () => {
    startProcess(1);
    const bound = { platform: {} } as App;
    const ctx = new ContextContainer();
    bindApp(ctx, bound);
    expect(requireApp(ctx)).toBe(bound);
  });

  it("is not read outside a step", () => {
    startProcess(undefined);
    expect(() => requireApp(new ContextContainer())).toThrow(
      "eve read the app outside of a request, a turn, or a step.",
    );
  });
});

describe("the ambient platform", () => {
  const PROCESS_PLATFORM = Symbol.for("eve.process-platform");
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[PROCESS_PLATFORM];
  });

  it("is the bound app's platform, then the platform module's, and else none", () => {
    expect(ambientPlatform()).toBeUndefined();

    selectProcessPlatform(testPlatform());
    expect(ambientPlatform()?.deployment.environment()).toBeUndefined();
    expect(ambientPlatform()).toBeDefined();

    const platform = testEntities();
    expect(runInApp({ platform } as App, () => ambientPlatform())).toBe(platform);
  });
});
