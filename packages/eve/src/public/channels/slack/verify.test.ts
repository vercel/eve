import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { verifySlackRequest, type SlackWebhookVerifier } from "#public/channels/slack/verify.js";

const SECRET = "test-signing-secret";

function signedRequest(input: {
  body: string;
  timestamp?: number;
  secret?: string;
  signature?: string;
  omitTimestamp?: boolean;
  omitSignature?: boolean;
}): Request {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const secret = input.secret ?? SECRET;
  const signature =
    input.signature ??
    `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${input.body}`).digest("hex")}`;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!input.omitTimestamp) headers["x-slack-request-timestamp"] = String(timestamp);
  if (!input.omitSignature) headers["x-slack-signature"] = signature;

  return new Request("https://example.com/eve/v1/slack", {
    method: "POST",
    headers,
    body: input.body,
  });
}

describe("verifySlackRequest — HMAC path", () => {
  it("returns the raw body when the v0 signature matches", async () => {
    const body = JSON.stringify({ type: "event_callback" });
    const req = signedRequest({ body });

    await expect(
      verifySlackRequest(req, { signingSecret: SECRET, webhookVerifier: undefined }),
    ).resolves.toBe(body);
  });

  it("rejects when the signature was computed with a different secret", async () => {
    const body = JSON.stringify({ type: "event_callback" });
    const req = signedRequest({ body, secret: "wrong-secret" });

    await expect(
      verifySlackRequest(req, { signingSecret: SECRET, webhookVerifier: undefined }),
    ).rejects.toThrow("signature mismatch");
  });

  it("rejects when the timestamp is older than the default 5-minute skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ type: "event_callback" });
    const req = signedRequest({ body, timestamp: now - 60 * 6 });

    await expect(
      verifySlackRequest(req, { signingSecret: SECRET, webhookVerifier: undefined }),
    ).rejects.toThrow("timestamp outside allowed skew");
  });

  it("rejects when the timestamp header is malformed", async () => {
    const body = "{}";
    const req = signedRequest({ body, signature: "v0=deadbeef" });
    req.headers.set("x-slack-request-timestamp", "not-a-number");

    await expect(
      verifySlackRequest(req, { signingSecret: SECRET, webhookVerifier: undefined }),
    ).rejects.toThrow("malformed timestamp");
  });

  it("rejects when the timestamp header is missing", async () => {
    const body = "{}";
    const req = signedRequest({ body, omitTimestamp: true });

    await expect(
      verifySlackRequest(req, { signingSecret: SECRET, webhookVerifier: undefined }),
    ).rejects.toThrow("missing Slack signature headers");
  });

  it("rejects when the signature header is missing", async () => {
    const body = "{}";
    const req = signedRequest({ body, omitSignature: true });

    await expect(
      verifySlackRequest(req, { signingSecret: SECRET, webhookVerifier: undefined }),
    ).rejects.toThrow("missing Slack signature headers");
  });

  it("rejects when neither signing secret nor verifier is configured", async () => {
    const body = "{}";
    const req = signedRequest({ body });

    await expect(
      verifySlackRequest(req, { signingSecret: undefined, webhookVerifier: undefined }),
    ).rejects.toThrow("missing signing secret");
  });

  it("accepts older timestamps when a wider skew is supplied", async () => {
    const now = Math.floor(Date.now() / 1000);
    const body = "{}";
    const req = signedRequest({ body, timestamp: now - 60 * 30 });

    await expect(
      verifySlackRequest(req, {
        signingSecret: SECRET,
        webhookVerifier: undefined,
        maxSkewSeconds: 60 * 60,
      }),
    ).resolves.toBe(body);
  });

  it("returns the raw body verbatim — signing happens over the literal payload", async () => {
    const body = '{"hello":"world","unicode":"\\u00e9"}';
    const req = signedRequest({ body });

    await expect(
      verifySlackRequest(req, { signingSecret: SECRET, webhookVerifier: undefined }),
    ).resolves.toBe(body);
  });
});

describe("verifySlackRequest — caller-supplied verifier path", () => {
  it("delegates to webhookVerifier and skips the HMAC check", async () => {
    const verifier = vi.fn<SlackWebhookVerifier>(async () => true);
    const body = JSON.stringify({ type: "event_callback" });
    const req = new Request("https://example.com/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    await expect(
      verifySlackRequest(req, { signingSecret: undefined, webhookVerifier: verifier }),
    ).resolves.toBe(body);

    expect(verifier).toHaveBeenCalledTimes(1);
    const [requestArg, bodyArg] = verifier.mock.calls[0]!;
    expect(requestArg).toBe(req);
    expect(bodyArg).toBe(body);
  });

  it("propagates the rejection when webhookVerifier throws", async () => {
    const verifier = vi.fn().mockRejectedValue(new Error("not authorized"));
    const req = new Request("https://example.com/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    await expect(
      verifySlackRequest(req, { signingSecret: undefined, webhookVerifier: verifier }),
    ).rejects.toThrow("not authorized");
  });

  it("rejects when webhookVerifier returns null (Connect's vercelOidc rejection path)", async () => {
    const verifier = vi.fn<SlackWebhookVerifier>(async () => null);
    const req = new Request("https://example.com/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    await expect(
      verifySlackRequest(req, { signingSecret: undefined, webhookVerifier: verifier }),
    ).rejects.toThrow("verifier rejected");
  });

  it("rejects when webhookVerifier returns false / undefined / empty string", async () => {
    const cases: Array<unknown> = [false, undefined, "", 0];
    for (const value of cases) {
      const verifier = vi.fn<SlackWebhookVerifier>(async () => value);
      const req = new Request("https://example.com/eve/v1/slack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      await expect(
        verifySlackRequest(req, { signingSecret: undefined, webhookVerifier: verifier }),
      ).rejects.toThrow("verifier rejected");
    }
  });

  it("substitutes the body when webhookVerifier returns a string", async () => {
    const canonicalized = '{"type":"event_callback","canonicalized":true}';
    const verifier = vi.fn<SlackWebhookVerifier>(async () => canonicalized);
    const req = new Request("https://example.com/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"type":"event_callback","raw":true}',
    });

    await expect(
      verifySlackRequest(req, { signingSecret: undefined, webhookVerifier: verifier }),
    ).resolves.toBe(canonicalized);
  });

  it("accepts arbitrary truthy values (non-string) and returns the original body", async () => {
    const sessionAuth = { principalId: "vercel:project:owner" };
    const verifier = vi.fn<SlackWebhookVerifier>(async () => sessionAuth);
    const body = '{"type":"event_callback"}';
    const req = new Request("https://example.com/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    await expect(
      verifySlackRequest(req, { signingSecret: undefined, webhookVerifier: verifier }),
    ).resolves.toBe(body);
  });

  it("prefers the verifier over an available signing secret", async () => {
    const verifier = vi.fn<SlackWebhookVerifier>(async () => true);
    const body = "{}";
    const req = signedRequest({ body, secret: "totally-wrong-secret" });

    await expect(
      verifySlackRequest(req, { signingSecret: SECRET, webhookVerifier: verifier }),
    ).resolves.toBe(body);

    expect(verifier).toHaveBeenCalledTimes(1);
  });
});
