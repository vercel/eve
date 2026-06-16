import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import {
  clearGitHubInstallationTokenCache,
  seedGitHubInstallationTokenForTests,
} from "#public/channels/github/auth.js";
import { checkoutGitHubRepository } from "#public/channels/github/checkout.js";

const credentials = {
  appId: "test-app",
};

beforeEach(() => {
  clearGitHubInstallationTokenCache();
  for (const apiBaseUrl of ["https://api.github.com", "https://github.test"]) {
    seedGitHubInstallationTokenForTests({ apiBaseUrl, installationId: 55, token: "ghs_checkout" });
  }
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    base: {
      ref: "main",
      repo: { default_branch: "main", full_name: "vercel/eve" },
      sha: "b".repeat(40),
    },
    head: { ref: "feature", repo: { full_name: "octocat/eve" }, sha: null },
    number: 7,
    title: "Checkout",
    ...overrides,
  };
}

describe("GitHub checkout", () => {
  it("fetches and checks out a shallow commit, brokering the token at the firewall", async () => {
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const sandbox = mockSandbox({
      run(options) {
        if (options.command.includes("git rev-parse HEAD 2>/dev/null")) {
          return { exitCode: 128, stderr: "", stdout: "" };
        }
        if (options.command.includes("git rev-parse HEAD")) {
          return { exitCode: 0, stderr: "", stdout: `${headSha}\n` };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    const checkout = await checkoutGitHubRepository(sandbox.session, {
      baseRef: "main",
      baseSha,
      credentials,
      headSha,
      includeBase: true,
      installationId: 55,
      owner: "vercel",
      repo: "eve",
    });

    expect(checkout).toEqual({
      baseRef: "main",
      path: "/workspace",
      ref: headSha,
      sha: headSha,
    });
    expect(sandbox.commandLog).toContain(
      `cd '/workspace' && GIT_TERMINAL_PROMPT=0 git fetch --depth 1 origin '${headSha}'`,
    );
    expect(sandbox.commandLog).toContain(`cd '/workspace' && git checkout --detach '${headSha}'`);
    expect(sandbox.commandLog).toContain(
      `cd '/workspace' && GIT_TERMINAL_PROMPT=0 git fetch --depth 1 origin '${baseSha}'`,
    );
    // Clean remote — the token is never embedded in the URL.
    expect(sandbox.commandLog).toContain(
      `cd '/workspace' && git remote add origin 'https://github.com/vercel/eve.git'`,
    );
    // No scrub step and no token anywhere in the command stream.
    expect(sandbox.commandLog.some((command) => command.includes("git remote set-url"))).toBe(
      false,
    );
    expect(sandbox.commandLog.some((command) => command.includes("ghs_checkout"))).toBe(false);
    // Token brokered at the firewall via a github.com header transform.
    const authorization = `Basic ${Buffer.from("x-access-token:ghs_checkout").toString("base64")}`;
    expect(sandbox.networkPolicyUpdates).toEqual([
      {
        allow: {
          "github.com": [{ transform: [{ headers: { Authorization: authorization } }] }],
          "codeload.github.com": [{ transform: [{ headers: { Authorization: authorization } }] }],
          "*": [],
        },
      },
    ]);
  });

  it("skips fetch when the workspace is already at the target commit", async () => {
    const headSha = "a".repeat(40);
    const fetchMock = vi.fn();
    const sandbox = mockSandbox({
      run(options) {
        if (options.command.includes("git rev-parse HEAD 2>/dev/null")) {
          return { exitCode: 0, stderr: "", stdout: `${headSha}\n` };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    const checkout = await checkoutGitHubRepository(sandbox.session, {
      api: { fetch: fetchMock },
      baseRef: "main",
      credentials,
      headSha,
      includeBase: true,
      installationId: 55,
      owner: "vercel",
      repo: "eve",
    });

    expect(checkout).toEqual({ baseRef: "main", path: "/workspace", ref: headSha, sha: headSha });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sandbox.commandLog.some((command) => command.includes("git fetch"))).toBe(false);
    // Cheap path: no token minted, no firewall policy applied.
    expect(sandbox.networkPolicyUpdates).toEqual([]);
  });

  it("falls back to refs/pull when PR metadata lacks a head SHA", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(pullRequest()));
    const sandbox = mockSandbox({
      run(options) {
        if (options.command.includes("git rev-parse HEAD")) {
          return { exitCode: 0, stderr: "", stdout: `${"c".repeat(40)}\n` };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    const checkout = await checkoutGitHubRepository(sandbox.session, {
      api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
      credentials,
      installationId: 55,
      owner: "vercel",
      pullRequestNumber: 7,
      repo: "eve",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://github.test/repos/vercel/eve/pulls/7");
    expect(checkout.ref).toBe("refs/pull/7/head");
    expect(sandbox.commandLog).toContain(
      "cd '/workspace' && GIT_TERMINAL_PROMPT=0 git fetch --depth 1 origin 'refs/pull/7/head'",
    );
  });

  it("surfaces fetch failures with an installation-access hint", async () => {
    const headSha = "e".repeat(40);
    const sandbox = mockSandbox({
      run(options) {
        if (options.command.includes("git fetch")) {
          return {
            exitCode: 128,
            stderr: "fatal: could not read from remote repository",
            stdout: "",
          };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    await expect(
      checkoutGitHubRepository(sandbox.session, {
        credentials,
        headSha,
        installationId: 55,
        owner: "vercel",
        repo: "eve",
      }),
    ).rejects.toThrow("Verify the GitHub App installation has access to this repository");
  });
});
