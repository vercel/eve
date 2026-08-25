import type { AuthFn } from "#public/channels/auth.js";
import type { EveChannelInput } from "#public/channels/eve.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  evaluationUser: vi.fn(),
  localDev: vi.fn(),
  placeholderAuth: vi.fn(),
  vercelOidc: vi.fn(),
}));

let capturedAuth: EveChannelInput["auth"] | undefined;

vi.mock("#public/channels/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#public/channels/auth.js")>()),
  localDev: mocks.localDev,
  placeholderAuth: mocks.placeholderAuth,
  vercelOidc: mocks.vercelOidc,
}));

vi.mock("#runtime/framework-channels/evaluation-auth.js", () => ({
  evaluationUser: mocks.evaluationUser,
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
  mocks.evaluationUser.mockReset();
  mocks.localDev.mockReset();
  mocks.placeholderAuth.mockReset();
  mocks.vercelOidc.mockReset();
});

describe("framework eve channel auth", () => {
  it("checks Vercel OIDC, the eval user, local dev, then the fail-closed placeholder", () => {
    const vercelAuth: AuthFn<Request> = () => null;
    const evalUser: AuthFn<Request> = () => null;
    const local: AuthFn<Request> = () => null;
    const placeholder: AuthFn<Request> = () => null;
    mocks.vercelOidc.mockReturnValue(vercelAuth);
    mocks.evaluationUser.mockReturnValue(evalUser);
    mocks.localDev.mockReturnValue(local);
    mocks.placeholderAuth.mockReturnValue(placeholder);

    getFrameworkChannelDefinitions();

    expect(capturedAuth).toEqual([vercelAuth, evalUser, local, placeholder]);
    expect(mocks.vercelOidc).toHaveBeenCalledWith();
    expect(mocks.evaluationUser).toHaveBeenCalledWith();
    expect(mocks.localDev).toHaveBeenCalledWith();
    expect(mocks.placeholderAuth).toHaveBeenCalledWith();
  });
});
