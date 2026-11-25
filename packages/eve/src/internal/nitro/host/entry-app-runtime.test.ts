import { describe, expect, it, vi } from "vitest";

vi.mock("#instrumentation/providers.js", () => ({ instrumentationLoaded: () => true }));

const { createEntryAppStart } = await import("#internal/nitro/host/entry-app-runtime.js");

describe("an entry build with AsyncLocalStorage", () => {
  it("starts and serves requests", async () => {
    const app = await createEntryAppStart(async () => ({ fetch: () => new Response("ok") }))();
    const response = await app.fetch(new Request("https://agent.example.com/"));
    expect(await response.text()).toBe("ok");
  });
});
