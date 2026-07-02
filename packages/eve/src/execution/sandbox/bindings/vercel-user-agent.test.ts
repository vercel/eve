import { describe, expect, it, vi } from "vitest";

import { withEveSandboxUserAgent } from "#execution/sandbox/bindings/vercel-user-agent.js";

function userAgentOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("user-agent");
}

describe("withEveSandboxUserAgent", () => {
  it("appends the eve token to an existing user-agent", async () => {
    const inner = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response());
    const wrapped = withEveSandboxUserAgent(inner);

    await wrapped("https://api.vercel.com/sandboxes", {
      headers: { "user-agent": "vercel/sandbox/2.2.0" },
    });

    const [, init] = inner.mock.calls[0]!;
    expect(userAgentOf(init)).toMatch(/^vercel\/sandbox\/2\.2\.0 eve\/.+/);
  });

  it("sets the eve token as the user-agent when none is present", async () => {
    const inner = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response());
    const wrapped = withEveSandboxUserAgent(inner);

    await wrapped("https://api.vercel.com/sandboxes");

    const [, init] = inner.mock.calls[0]!;
    expect(userAgentOf(init)).toMatch(/^eve\/.+/);
  });

  it("delegates to globalThis.fetch when no inner fetch is supplied", () => {
    const wrapped = withEveSandboxUserAgent();
    expect(typeof wrapped).toBe("function");
  });
});
