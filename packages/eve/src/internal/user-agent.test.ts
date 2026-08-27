import { describe, expect, it, vi } from "vitest";

import { withPackageUserAgent } from "#internal/user-agent.js";

function userAgentOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("user-agent");
}

describe("withPackageUserAgent", () => {
  it("appends the eve token to an existing user-agent", async () => {
    const inner = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response());
    const wrapped = withPackageUserAgent(inner);

    await wrapped("https://api.vercel.com/sandboxes", {
      headers: { "user-agent": "vercel/sandbox/2.2.0" },
    });

    const [, init] = inner.mock.calls[0]!;
    expect(userAgentOf(init)).toMatch(/^vercel\/sandbox\/2\.2\.0 eve\/.+/);
  });

  it("sets the eve token as the user-agent when none is present", async () => {
    const inner = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response());
    const wrapped = withPackageUserAgent(inner);

    await wrapped("https://api.vercel.com/sandboxes");

    const [, init] = inner.mock.calls[0]!;
    expect(userAgentOf(init)).toMatch(/^eve\/.+/);
  });

  it("does not append the token twice", async () => {
    const inner = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response());
    const wrapped = withPackageUserAgent(withPackageUserAgent(inner));

    await wrapped("https://ai-gateway.vercel.sh/v1/models");

    const [, init] = inner.mock.calls[0]!;
    expect(userAgentOf(init)).toMatch(/^eve\/[^ ]+$/);
  });

  it("delegates to globalThis.fetch when no inner fetch is supplied", () => {
    const wrapped = withPackageUserAgent();
    expect(typeof wrapped).toBe("function");
  });
});
