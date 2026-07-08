import { afterEach, describe, expect, it, vi } from "vitest";

interface CapturedCreateVercelSandboxInput {
  readonly createOptions: {
    readonly fetch: typeof globalThis.fetch;
    readonly token?: string;
  };
}

const { createVercelSandbox } = vi.hoisted(() => ({
  createVercelSandbox: vi.fn((_: unknown) => ({ name: "islo" })),
}));

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

    const call = createVercelSandbox.mock.calls[0]?.[0] as CapturedCreateVercelSandboxInput;
    expect(call.createOptions.token).toBe("islo-token");
  });

  it("rewrites Vercel API fetch URLs to the Islo API host", async () => {
    const delegate = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    islo({ fetch: delegate });

    const call = createVercelSandbox.mock.calls[0]?.[0] as CapturedCreateVercelSandboxInput;
    const fetch = call.createOptions.fetch;
    await fetch("https://api.vercel.com/v10/sandboxes");

    const requestOrUrl = delegate.mock.calls[0]?.[0] as string | URL | Request | undefined;
    expect(requestOrUrl).toBeDefined();
    const url = requestOrUrl instanceof Request ? requestOrUrl.url : String(requestOrUrl);
    expect(url).toBe("https://api.islo.dev/v10/sandboxes");
  });
});
