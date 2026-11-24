import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "AsyncLocalStorage");
  vi.resetModules();
});

describe("the web async storage twin", () => {
  it("uses the runtime's global AsyncLocalStorage", async () => {
    Object.assign(globalThis, { AsyncLocalStorage });
    const { asyncLocalStorage } = await import("#runtime-env/async-storage.web.js");
    expect(asyncLocalStorage).toBe(AsyncLocalStorage);
  });

  it("has none when the runtime provides none", async () => {
    const { asyncLocalStorage } = await import("#runtime-env/async-storage.web.js");
    expect(asyncLocalStorage).toBeUndefined();
  });
});
