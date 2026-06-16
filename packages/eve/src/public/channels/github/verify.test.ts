import { describe, expect, it, vi } from "vitest";

import {
  signGitHubWebhookBody,
  verifyGitHubRequest,
  type GitHubWebhookVerifier,
} from "#public/channels/github/verify.js";

const SECRET = "github-secret";

function signedRequest(body: string, signature = signGitHubWebhookBody(body, SECRET)): Request {
  return new Request("https://example.com/eve/v1/github", {
    body,
    headers: {
      "x-hub-signature-256": signature,
    },
    method: "POST",
  });
}

function jsonRequest(body: string): Request {
  return new Request("https://example.com/eve/v1/github", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

describe("verifyGitHubRequest", () => {
  it("accepts a valid sha256 signature", async () => {
    const body = JSON.stringify({ zen: "Keep it logically awesome." });

    await expect(verifyGitHubRequest(signedRequest(body), { webhookSecret: SECRET })).resolves.toBe(
      body,
    );
  });

  it("rejects an invalid signature", async () => {
    const body = JSON.stringify({ action: "created" });

    await expect(
      verifyGitHubRequest(signedRequest(body, "sha256=bad"), { webhookSecret: SECRET }),
    ).rejects.toThrow("signature mismatch");
  });

  it("rejects when no verifier or secret is configured", async () => {
    await expect(verifyGitHubRequest(signedRequest("{}"), {})).rejects.toThrow(
      "GITHUB_WEBHOOK_SECRET",
    );
  });

  it("verifies the raw form-encoded body", async () => {
    const body = new URLSearchParams({
      payload: JSON.stringify({ action: "created", body: "a=b" }),
    }).toString();

    await expect(verifyGitHubRequest(signedRequest(body), { webhookSecret: SECRET })).resolves.toBe(
      body,
    );
  });
});

describe("verifyGitHubRequest — caller-supplied verifier path", () => {
  it("delegates to webhookVerifier and skips the HMAC check", async () => {
    const verifier = vi.fn<GitHubWebhookVerifier>(async () => true);
    const body = JSON.stringify({ action: "created" });
    const req = jsonRequest(body);

    await expect(verifyGitHubRequest(req, { webhookVerifier: verifier })).resolves.toBe(body);

    expect(verifier).toHaveBeenCalledTimes(1);
    const [requestArg, bodyArg] = verifier.mock.calls[0]!;
    expect(requestArg).toBe(req);
    expect(bodyArg).toBe(body);
  });

  it("propagates the rejection when webhookVerifier throws", async () => {
    const verifier = vi.fn().mockRejectedValue(new Error("not authorized"));

    await expect(
      verifyGitHubRequest(jsonRequest("{}"), { webhookVerifier: verifier }),
    ).rejects.toThrow("not authorized");
  });

  it("rejects when webhookVerifier returns null (Connect's vercelOidc rejection path)", async () => {
    const verifier = vi.fn<GitHubWebhookVerifier>(async () => null);

    await expect(
      verifyGitHubRequest(jsonRequest("{}"), { webhookVerifier: verifier }),
    ).rejects.toThrow("verifier rejected");
  });

  it("rejects when webhookVerifier returns false / undefined / empty string / 0", async () => {
    for (const value of [false, undefined, "", 0]) {
      const verifier = vi.fn<GitHubWebhookVerifier>(async () => value);

      await expect(
        verifyGitHubRequest(jsonRequest("{}"), { webhookVerifier: verifier }),
      ).rejects.toThrow("verifier rejected");
    }
  });

  it("substitutes the body when webhookVerifier returns a string", async () => {
    const canonicalized = '{"action":"created","canonicalized":true}';
    const verifier = vi.fn<GitHubWebhookVerifier>(async () => canonicalized);

    await expect(
      verifyGitHubRequest(jsonRequest('{"action":"created"}'), { webhookVerifier: verifier }),
    ).resolves.toBe(canonicalized);
  });

  it("prefers the verifier over an available webhook secret and never reads it", async () => {
    const verifier = vi.fn<GitHubWebhookVerifier>(async () => true);
    const body = "{}";
    // Signature is wrong for SECRET, but the verifier path must not HMAC.
    const req = signedRequest(body, "sha256=bad");

    await expect(
      verifyGitHubRequest(req, { webhookSecret: SECRET, webhookVerifier: verifier }),
    ).resolves.toBe(body);
  });
});
