import { afterEach, describe, expect, it, vi } from "vitest";

const getToken = vi.fn();
vi.mock("@vercel/connect", () => ({ getToken }));

import { createVercelConnectCredentialProvider } from "./credentials.js";

afterEach(() => {
  getToken.mockReset();
  delete process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN;
});

describe("Vercel Connect GitHub credentials", () => {
  it("requests a repository-bound checkout token", async () => {
    getToken.mockResolvedValue("checkout-token");
    await expect(
      createVercelConnectCredentialProvider("github/selfmod-acme-agents").resolve({
        capability: "checkout",
        repository: { owner: "acme", repo: "agents" },
      }),
    ).resolves.toBe("checkout-token");
    expect(getToken).toHaveBeenCalledWith("github/selfmod-acme-agents", {
      authorizationDetails: [{ repositories: ["acme/agents"], type: "github_app_installation" }],
      scopes: ["contents:read", "metadata:read"],
      subject: { type: "app" },
    });
  });

  it("requests publication scopes without falling back to a PAT", async () => {
    process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN = "pat-that-must-not-be-read";
    getToken.mockRejectedValue(new Error("not attached"));
    await expect(
      createVercelConnectCredentialProvider("github/selfmod-acme-agents").resolve({
        capability: "publish",
        repository: { owner: "acme", repo: "agents" },
      }),
    ).rejects.toThrow("Vercel Connect");
    expect(getToken).toHaveBeenCalledWith("github/selfmod-acme-agents", {
      authorizationDetails: [{ repositories: ["acme/agents"], type: "github_app_installation" }],
      scopes: ["contents:write", "pull_requests:write", "metadata:read"],
      subject: { type: "app" },
    });
  });
});
