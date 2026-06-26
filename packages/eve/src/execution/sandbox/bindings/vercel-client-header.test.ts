import { describe, expect, it, vi } from "vitest";

import {
  EVE_SANDBOX_CLIENT_HEADER,
  withEveSandboxClientHeader,
} from "#execution/sandbox/bindings/vercel-client-header.js";
import { getVercelSandboxFetch } from "#execution/sandbox/bindings/vercel-credentials.js";
import { createVercelEveImageSandbox } from "#execution/sandbox/bindings/vercel-create-sdk.js";
import type { VercelSandboxCreateParams } from "#execution/sandbox/bindings/vercel-create-sdk.js";
import type { VercelCreateOptions } from "#execution/sandbox/bindings/vercel-sdk-types.js";

function headerOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get(EVE_SANDBOX_CLIENT_HEADER);
}

describe("withEveSandboxClientHeader", () => {
  it("stamps the eve client header as eve/<version>", async () => {
    const inner = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response());
    const wrapped = withEveSandboxClientHeader(inner);

    await wrapped("https://api.vercel.com/sandboxes");

    const [, init] = inner.mock.calls[0]!;
    expect(headerOf(init)).toMatch(/^eve\/.+/);
  });

  it("preserves existing headers", async () => {
    const inner = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response());
    const wrapped = withEveSandboxClientHeader(inner);

    await wrapped("https://api.vercel.com/sandboxes", {
      headers: { "user-agent": "vercel/sandbox/1.0.0" },
    });

    const [, init] = inner.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("user-agent")).toBe("vercel/sandbox/1.0.0");
    expect(headers.get(EVE_SANDBOX_CLIENT_HEADER)).toMatch(/^eve\/.+/);
  });

  it("delegates to globalThis.fetch when no inner fetch is supplied", () => {
    const wrapped = withEveSandboxClientHeader();
    expect(typeof wrapped).toBe("function");
  });
});

describe("getVercelSandboxFetch", () => {
  it("returns a fetch that injects the eve client header (lookup/get path)", async () => {
    const override = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response());
    const createOptions: VercelCreateOptions = { fetch: override };
    const fetchImpl = getVercelSandboxFetch(createOptions);

    await fetchImpl("https://api.vercel.com/sandboxes/foo");

    const [, init] = override.mock.calls[0]!;
    expect(headerOf(init)).toMatch(/^eve\/.+/);
  });
});

describe("createVercelEveImageSandbox", () => {
  it("passes a header-injecting fetch through to Sandbox.create", async () => {
    const override = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response());
    let capturedFetch: typeof globalThis.fetch | undefined;
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(async (options: VercelSandboxCreateParams) => {
          capturedFetch = (options as { fetch?: typeof globalThis.fetch }).fetch;
          return {};
        }),
      },
    };
    const createOptions: VercelSandboxCreateParams = {
      name: "agent",
      persistent: false,
      fetch: override,
    };

    await createVercelEveImageSandbox({ createOptions, sandboxModule: sandboxModule as never });

    expect(capturedFetch).toBeDefined();
    await capturedFetch!("https://api.vercel.com/sandboxes");
    const [, init] = override.mock.calls[0]!;
    expect(headerOf(init)).toMatch(/^eve\/.+/);
  });
});
