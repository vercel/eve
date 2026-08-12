import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#compiled/@vercel/oidc/index.js", () => ({
  getVercelOidcToken: vi.fn(),
}));

import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER } from "#client/types.js";

import { defineVercelBranchAgent } from "#public/agents/vercel.js";

describe("defineVercelBranchAgent", () => {
  afterEach(() => vi.resetAllMocks());

  it("returns a standard remote agent using Vercel OIDC", async () => {
    const agent = defineVercelBranchAgent({
      branch: "feature/preview-agent",
      description: "Preview agent.",
      forwardPrincipal: true,
      url: "https://my-agent-git-feature-preview-agent-acme.vercel.app",
    });

    expect(agent).toMatchObject({
      description: "Preview agent.",
      forwardPrincipal: true,
      kind: "remote",
      path: "/eve/v1/session",
      url: "https://my-agent-git-feature-preview-agent-acme.vercel.app",
    });
    vi.mocked(getVercelOidcToken).mockResolvedValue("oidc-token");
    await expect(agent.auth?.()).resolves.toEqual({
      headers: {
        authorization: "Bearer oidc-token",
        [VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER]: "oidc-token",
      },
    });
  });

  it("requires a branch", () => {
    expect(() =>
      defineVercelBranchAgent({
        branch: "  ",
        description: "Preview agent.",
        url: "https://preview.example.com",
      }),
    ).toThrow("requires a non-empty branch");
  });
});
