import type { AuthFn } from "#public/channels/auth.js";
import type { EveChannelInput } from "#public/channels/eve.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  localDev: vi.fn(),
  vercelOidc: vi.fn(),
}));

let capturedAuth: EveChannelInput["auth"] | undefined;

vi.mock("#public/channels/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#public/channels/auth.js")>()),
  localDev: mocks.localDev,
  vercelOidc: mocks.vercelOidc,
}));

vi.mock("#public/channels/eve.js", () => ({
  eveChannel(input: EveChannelInput) {
    capturedAuth = input.auth;
    return { adapter: {}, routes: [] };
  },
}));

import { getFrameworkChannelDefinitions } from "./index.js";

afterEach(() => {
  capturedAuth = undefined;
  mocks.localDev.mockReset();
  mocks.vercelOidc.mockReset();
});

describe("framework eve channel auth", () => {
  it("uses Vercel OIDC before the local-development fallback", () => {
    const vercelAuth: AuthFn<Request> = () => null;
    const localAuth: AuthFn<Request> = () => null;
    mocks.vercelOidc.mockReturnValue(vercelAuth);
    mocks.localDev.mockReturnValue(localAuth);

    getFrameworkChannelDefinitions();

    expect(capturedAuth).toEqual([vercelAuth, localAuth]);
    expect(mocks.vercelOidc).toHaveBeenCalledWith();
    expect(mocks.localDev).toHaveBeenCalledWith();
  });
});
