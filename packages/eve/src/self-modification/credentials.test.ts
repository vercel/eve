import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGitHubCredentialProvider,
  SELF_MODIFICATION_GITHUB_TOKEN_ENV,
} from "./credentials.js";

afterEach(() => {
  delete process.env[SELF_MODIFICATION_GITHUB_TOKEN_ENV];
});

const request = {
  capability: "checkout",
  repository: { owner: "acme", repo: "agents" },
} as const;

describe("self-modification GitHub credentials", () => {
  it("forwards requests to an application-supplied provider", async () => {
    const resolve = vi.fn().mockResolvedValue(" provider-token ");
    const provider = createGitHubCredentialProvider({
      kind: "provider",
      provider: { resolve },
    });

    await expect(provider.resolve(request)).resolves.toBe("provider-token");
    expect(resolve).toHaveBeenCalledWith(request);
  });

  it("does not fall back to the PAT when a provider fails", async () => {
    process.env[SELF_MODIFICATION_GITHUB_TOKEN_ENV] = "pat-that-must-not-be-read";
    const failure = new Error("provider failed");
    const provider = createGitHubCredentialProvider({
      kind: "provider",
      provider: { resolve: vi.fn().mockRejectedValue(failure) },
    });

    await expect(provider.resolve(request)).rejects.toBe(failure);
  });

  it("rejects an empty provider token", async () => {
    const provider = createGitHubCredentialProvider({
      kind: "provider",
      provider: { resolve: vi.fn().mockResolvedValue("  ") },
    });

    await expect(provider.resolve(request)).rejects.toThrow("returned an empty GitHub token");
  });
});
