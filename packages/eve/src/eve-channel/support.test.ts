import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { resolveEveAudience } from "#eve-channel/support.js";
import { getLocalDevCapability } from "#runtime/local-dev-capability.js";

vi.mock("#runtime/local-dev-capability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#runtime/local-dev-capability.js")>()),
  getLocalDevCapability: vi.fn(),
}));

const AUTH: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "user-1",
  principalType: "user",
};

afterEach(() => {
  vi.resetAllMocks();
});

describe("resolveEveAudience", () => {
  it("classifies an attested local TUI as private without consulting authored policy", async () => {
    vi.mocked(getLocalDevCapability).mockReturnValue({
      appRoot: "/app",
      interactiveClient: true,
      async withSuspendedSource<T>(task: () => Promise<T>): Promise<T> {
        return await task();
      },
    });
    const audience = vi.fn(() => "public" as const);
    const request = new Request("http://127.0.0.1:3000/eve/v1/session");

    await expect(
      resolveEveAudience({
        auth: AUTH,
        config: { audience, auth: () => AUTH },
        request,
      }),
    ).resolves.toBe("private");
    expect(audience).not.toHaveBeenCalled();
  });

  it("passes a flat context to authored policy outside a local TUI request", async () => {
    vi.mocked(getLocalDevCapability).mockReturnValue(undefined);
    const request = new Request("https://agent.example.com/eve/v1/session");
    const audience = vi.fn((ctx) => {
      expect(ctx).toEqual({ caller: AUTH, request });
      return "public" as const;
    });

    await expect(
      resolveEveAudience({
        auth: AUTH,
        config: { audience, auth: () => AUTH },
        request,
      }),
    ).resolves.toBe("public");
    expect(audience).toHaveBeenCalledOnce();
  });
});
