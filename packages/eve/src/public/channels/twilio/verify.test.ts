import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildTwilioSignatureBase,
  signTwilioRequest,
  verifyTwilioRequest,
} from "#public/channels/twilio/verify.js";

const AUTH_TOKEN = "test-auth-token";

function signedRequest(input: {
  readonly url?: string;
  readonly body: URLSearchParams;
  readonly authToken?: string;
  readonly signature?: string;
  readonly omitSignature?: boolean;
}): Request {
  const url = input.url ?? "https://example.com/eve/v1/twilio/messages?foo=bar";
  const signature =
    input.signature ??
    signTwilioRequest({
      authToken: input.authToken ?? AUTH_TOKEN,
      params: input.body,
      url,
    });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (!input.omitSignature) headers["x-twilio-signature"] = signature;
  return new Request(url, { body: input.body, headers, method: "POST" });
}

describe("buildTwilioSignatureBase", () => {
  it("uses the exact URL and sorted POST parameters", () => {
    const params = new URLSearchParams();
    params.set("Body", "hello");
    params.set("From", "+15551234567");
    params.set("AccountSid", "AC123");

    expect(buildTwilioSignatureBase("https://example.com/twilio?x=1", params)).toBe(
      "https://example.com/twilio?x=1AccountSidAC123BodyhelloFrom+15551234567",
    );
  });

  it("matches the direct HMAC-SHA1/base64 calculation", () => {
    const params = new URLSearchParams({ Body: "hello", From: "+15551234567" });
    const base = buildTwilioSignatureBase("https://example.com/twilio", params);

    expect(
      signTwilioRequest({ authToken: AUTH_TOKEN, params, url: "https://example.com/twilio" }),
    ).toBe(createHmac("sha1", AUTH_TOKEN).update(base).digest("base64"));
  });
});

describe("verifyTwilioRequest", () => {
  it("returns the raw body and params when the signature matches", async () => {
    const body = new URLSearchParams({ Body: "hello", From: "+15551234567", To: "+15557654321" });
    const req = signedRequest({ body });

    await expect(verifyTwilioRequest(req, { authToken: AUTH_TOKEN })).resolves.toMatchObject({
      body: body.toString(),
    });
  });

  it("rejects when the signature was computed with another token", async () => {
    const body = new URLSearchParams({ Body: "hello", From: "+15551234567" });
    const req = signedRequest({ authToken: "wrong-token", body });

    await expect(verifyTwilioRequest(req, { authToken: AUTH_TOKEN })).rejects.toThrow(
      "signature mismatch",
    );
  });

  it("rejects when the signature header is missing", async () => {
    const body = new URLSearchParams({ Body: "hello", From: "+15551234567" });
    const req = signedRequest({ body, omitSignature: true });

    await expect(verifyTwilioRequest(req, { authToken: AUTH_TOKEN })).rejects.toThrow(
      "missing X-Twilio-Signature",
    );
  });

  it("accepts a public webhook URL override for proxy/tunnel deployments", async () => {
    const body = new URLSearchParams({ Body: "hello", From: "+15551234567" });
    const publicUrl = "https://public.example.com/twilio/messages";
    const signature = signTwilioRequest({ authToken: AUTH_TOKEN, params: body, url: publicUrl });
    const req = signedRequest({
      body,
      signature,
      url: "http://127.0.0.1:3000/twilio/messages",
    });

    await expect(
      verifyTwilioRequest(req, { authToken: AUTH_TOKEN, webhookUrl: publicUrl }),
    ).resolves.toMatchObject({ body: body.toString() });
  });
});
