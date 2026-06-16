import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearGitHubInstallationTokenCache,
  createGitHubAppJwt,
  createGitHubInstallationToken,
  normalizeGitHubPrivateKey,
  resolveGitHubAppId,
  resolveGitHubInstallationToken,
  resolveGitHubPrivateKey,
  resolveGitHubWebhookSecret,
} from "#public/channels/github/auth.js";

function keyPair(): { privateKey: string; publicKey: string } {
  const generated = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: generated.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: generated.publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

describe("GitHub App auth helpers", () => {
  beforeEach(() => {
    clearGitHubInstallationTokenCache();
    vi.unstubAllEnvs();
  });

  it("creates an RS256 GitHub App JWT", async () => {
    const { privateKey, publicKey } = keyPair();
    const jwt = await createGitHubAppJwt({
      appId: 12345,
      now: new Date("2026-06-01T00:00:00Z"),
      privateKey,
    });
    const [header, payload, signature] = jwt.split(".");

    expect(JSON.parse(Buffer.from(header!, "base64url").toString("utf8"))).toMatchObject({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))).toMatchObject({
      iss: "12345",
    });

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(createPublicKey(publicKey), Buffer.from(signature!, "base64url"))).toBe(
      true,
    );
  });

  it("exchanges and caches installation tokens", async () => {
    const { privateKey } = keyPair();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          expires_at: "2099-06-01T01:00:00Z",
          token: "ghs_installation",
        }),
      ),
    );

    const first = await createGitHubInstallationToken({
      api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
      appId: 1,
      installationId: 99,
      privateKey,
    });
    const second = await createGitHubInstallationToken({
      api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
      appId: 1,
      installationId: 99,
      privateKey,
    });

    expect(first).toBe("ghs_installation");
    expect(second).toBe("ghs_installation");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://github.test/app/installations/99/access_tokens",
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toMatch(
      /^Bearer .+\..+\..+$/u,
    );
  });

  it("returns a Connect-supplied installation token without minting one", async () => {
    const fetchMock = vi.fn();

    await expect(
      resolveGitHubInstallationToken({
        api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
        credentials: { installationToken: "ghs_connect" },
        installationId: undefined,
      }),
    ).resolves.toBe("ghs_connect");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a function-form installation token without an installationId", async () => {
    const fetchMock = vi.fn();
    const installationToken = vi.fn().mockResolvedValue("ghs_lazy");

    await expect(
      resolveGitHubInstallationToken({
        api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
        credentials: { installationToken },
        installationId: undefined,
      }),
    ).resolves.toBe("ghs_lazy");
    expect(installationToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an installationId when no installation token is supplied", async () => {
    await expect(
      resolveGitHubInstallationToken({ credentials: {}, installationId: undefined }),
    ).rejects.toThrow(/installationId is required/u);
  });

  it("normalizes escaped private-key newlines and resolves env fallbacks", async () => {
    vi.stubEnv("GITHUB_APP_ID", "42");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "line1\\nline2");
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "secret");

    await expect(resolveGitHubAppId()).resolves.toBe("42");
    await expect(resolveGitHubPrivateKey()).resolves.toBe("line1\nline2");
    await expect(resolveGitHubWebhookSecret()).resolves.toBe("secret");
    expect(normalizeGitHubPrivateKey("a\\nb")).toBe("a\nb");
  });
});
