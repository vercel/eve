import { describe, expect, it } from "vitest";

import { gitHubGitCredentials, gitHubRemoteUrl, isFullGitSha, isValidGitRef } from "./git.js";

describe("Git helpers", () => {
  it("recognizes full object SHAs", () => {
    expect(isFullGitSha("A".repeat(40))).toBe(true);
    expect(isFullGitSha("a".repeat(39))).toBe(false);
  });

  it("rejects unsafe Git refs", () => {
    expect(isValidGitRef("feature/self-modification")).toBe(true);
    expect(isValidGitRef("main.lock")).toBe(false);
    expect(isValidGitRef(".hidden")).toBe(false);
    expect(isValidGitRef("feature/.hidden")).toBe(false);
    expect(isValidGitRef("feature\x7fbranch")).toBe(false);
    expect(isValidGitRef("main; curl example.com")).toBe(false);
  });

  it("uses a clean GitHub remote and brokers credentials only at the firewall", () => {
    expect(gitHubRemoteUrl({ owner: "vercel", repo: "eve" })).toBe(
      "https://github.com/vercel/eve.git",
    );
    const authorization = `Basic ${Buffer.from("x-access-token:secret").toString("base64")}`;
    expect(gitHubGitCredentials("secret")).toEqual({
      "codeload.github.com": [{ transform: [{ headers: { Authorization: authorization } }] }],
      "github.com": [{ transform: [{ headers: { Authorization: authorization } }] }],
    });
  });
});
