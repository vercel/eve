import { afterEach, describe, expect, it, vi } from "vitest";

const createVercelSandbox = vi.fn(() => ({ name: "islo" }));

vi.mock("#execution/sandbox/bindings/vercel.js", () => ({
  createVercelSandbox,
}));

import { islo } from "#public/sandbox/backends/islo.js";

describe("islo sandbox backend", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    createVercelSandbox.mockClear();
  });

  it("configures the Vercel-compatible backend for Islo", () => {
    islo();

    expect(createVercelSandbox).toHaveBeenCalledTimes(1);
    expect(createVercelSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        backendName: "islo",
        providerName: "Islo",
      }),
    );
  });

  it("uses ISLO_TOKEN when token is omitted", () => {
    vi.stubEnv("ISLO_TOKEN", "islo-token");

    islo();

    const call = createVercelSandbox.mock.calls[0]?.[0];
    expect(call?.createOptions.token).toBe("islo-token");
  });

  it("rewrites Vercel API fetch URLs to the Islo API host", async () => {
    const delegate = vi.fn(async () => new Response(null, { status: 200 }));
    islo({ fetch: delegate });

    const call = createVercelSandbox.mock.calls[0]?.[0];
    const fetch = call?.createOptions.fetch as typeof globalThis.fetch;
    await fetch("https://api.vercel.com/v10/sandboxes");

    const [requestOrUrl] = delegate.mock.calls[0] ?? [];
    const url = requestOrUrl instanceof Request ? requestOrUrl.url : String(requestOrUrl);
    expect(url).toBe("https://api.islo.dev/v10/sandboxes");
  });
});
