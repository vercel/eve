import { describe, expect, it } from "vitest";

import { createLifetime, endLifetime, registerCleanup } from "#runtime/lifetime.js";

describe("endLifetime", () => {
  it("runs the cleanups once, newest first", async () => {
    const ended: string[] = [];
    const lifetime = createLifetime();
    registerCleanup(lifetime, () => void ended.push("world"));
    registerCleanup(lifetime, async () => void ended.push("instrumentation"));

    const ending = endLifetime(lifetime);

    expect(endLifetime(lifetime)).toBe(ending);
    await ending;
    expect(ended).toEqual(["instrumentation", "world"]);
  });

  it("ends the child lifetimes before its own cleanups", async () => {
    const ended: string[] = [];
    const app = createLifetime();
    registerCleanup(app, () => void ended.push("app"));
    const first = createLifetime(app);
    registerCleanup(first, () => void ended.push("first session"));
    const second = createLifetime(app);
    registerCleanup(second, () => void ended.push("second session"));

    await endLifetime(app);

    expect(ended).toEqual(["second session", "first session", "app"]);
  });

  it("runs every cleanup when one fails, then rejects with the failure", async () => {
    const ended: string[] = [];
    const lifetime = createLifetime();
    registerCleanup(lifetime, () => void ended.push("world"));
    registerCleanup(lifetime, () => {
      throw new Error("exporter unreachable");
    });

    await expect(endLifetime(lifetime)).rejects.toThrow("exporter unreachable");
    expect(ended).toEqual(["world"]);
  });

  it("ends every child and runs its own cleanups when a child fails, then rejects with the first failure", async () => {
    const ended: string[] = [];
    const app = createLifetime();
    registerCleanup(app, () => void ended.push("world"));
    registerCleanup(app, () => {
      throw new Error("exporter unreachable");
    });
    const first = createLifetime(app);
    registerCleanup(first, () => void ended.push("first session"));
    const second = createLifetime(app);
    registerCleanup(second, () => {
      throw new Error("sandbox unreachable");
    });

    await expect(endLifetime(app)).rejects.toThrow("sandbox unreachable");
    expect(ended).toEqual(["first session", "world"]);
  });

  it("waits for a child that is already ending before its own cleanups", async () => {
    const ended: string[] = [];
    const app = createLifetime();
    registerCleanup(app, () => void ended.push("world"));
    const session = createLifetime(app);
    const sandboxStopping = Promise.withResolvers<void>();
    const sandboxStopped = Promise.withResolvers<void>();
    registerCleanup(session, async () => {
      sandboxStopping.resolve();
      await sandboxStopped.promise;
      ended.push("sandbox");
    });

    const sessionEnding = endLifetime(session);
    await sandboxStopping.promise;
    const appEnding = endLifetime(app);
    await new Promise((resolve) => setTimeout(resolve));

    expect(ended).toEqual([]);
    sandboxStopped.resolve();
    await Promise.all([sessionEnding, appEnding]);
    expect(ended).toEqual(["sandbox", "world"]);
  });

  it("refuses cleanups and children once it has ended", async () => {
    const lifetime = createLifetime();
    const ending = endLifetime(lifetime);

    expect(() => registerCleanup(lifetime, () => {})).toThrow("lifetime that has ended");
    expect(() => createLifetime(lifetime)).toThrow("lifetime that has ended");
    await ending;
  });
});
