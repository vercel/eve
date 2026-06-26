import { describe, expect, it, vi } from "vitest";

import {
  EVE_SANDBOX_CLIENT_HEADER,
  withEveSandboxClientHeader,
} from "#execution/sandbox/bindings/vercel-client-header.js";

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
