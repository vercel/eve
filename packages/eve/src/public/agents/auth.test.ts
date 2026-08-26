import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#compiled/@vercel/oidc/index.js", () => ({
  getVercelOidcToken: vi.fn(),
}));

import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER } from "#client/types.js";
import { vercelOidc } from "#public/agents/auth.js";

describe("vercelOidc", () => {
  afterEach(() => vi.resetAllMocks());

  it("authenticates the eve route and Vercel Deployment Protection", async () => {
    vi.mocked(getVercelOidcToken).mockResolvedValue("oidc-token");

    const auth = vercelOidc({ project: "weather", team: "acme" });

    await expect(auth()).resolves.toEqual({
      headers: {
        authorization: "Bearer oidc-token",
        [VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER]: "oidc-token",
      },
    });
    expect(getVercelOidcToken).toHaveBeenCalledWith({ project: "weather", team: "acme" });
  });

  it("resolves a fresh token for each request", async () => {
    vi.mocked(getVercelOidcToken)
      .mockResolvedValueOnce("first-token")
      .mockResolvedValueOnce("second-token");
    const auth = vercelOidc();

    await expect(auth()).resolves.toMatchObject({
      headers: { authorization: "Bearer first-token" },
    });
    await expect(auth()).resolves.toMatchObject({
      headers: { authorization: "Bearer second-token" },
    });
  });
});
