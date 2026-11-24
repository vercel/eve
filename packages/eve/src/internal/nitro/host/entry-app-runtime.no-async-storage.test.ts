import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("#runtime-env/async-storage.js", () => import("#runtime-env/async-storage.web.js"));
vi.mock("#instrumentation/providers.js", () => ({ instrumentationLoaded: () => true }));

const CONTEXT_STORAGE = Symbol.for("eve.context-storage");
vi.hoisted(() => Reflect.deleteProperty(globalThis, Symbol.for("eve.context-storage")));
afterAll(() => Reflect.deleteProperty(globalThis, CONTEXT_STORAGE));

const { createEntryAppStart } = await import("#internal/nitro/host/entry-app-runtime.js");

describe("an entry build without AsyncLocalStorage", () => {
  it("refuses to start before it loads the server", async () => {
    const loadServer = vi.fn(async () => ({ fetch: () => new Response("ok") }));
    await expect(createEntryAppStart(loadServer)()).rejects.toThrow(
      "start() from eve:app needs AsyncLocalStorage to serve requests.",
    );
    expect(loadServer).not.toHaveBeenCalled();
  });
});
