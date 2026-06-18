import { describe, expect, it } from "vitest";

import {
  parseBlooioSignatureHeader,
  signBlooioPayload,
  verifyBlooioRequest,
} from "#public/channels/blooio/verify.js";

const SECRET = "whsec_test_secret";

function signedRequest(body: string, timestamp: number, secret = SECRET): Request {
  const signature = signBlooioPayload(secret, timestamp, body);
  return new Request("https://example.com/eve/v1/blooio", {
    method: "POST",
    headers: { "x-blooio-signature": `t=${timestamp},v1=${signature}` },
    body,
  });
}

describe("parseBlooioSignatureHeader", () => {
  it("parses t and v1", () => {
    expect(parseBlooioSignatureHeader("t=123,v1=abc")).toEqual({
      signature: "abc",
      timestamp: 123,
    });
  });

  it("returns null for malformed headers", () => {
    expect(parseBlooioSignatureHeader(null)).toBeNull();
    expect(parseBlooioSignatureHeader("v1=abc")).toBeNull();
    expect(parseBlooioSignatureHeader("t=notanumber,v1=abc")).toBeNull();
  });
});

describe("verifyBlooioRequest", () => {
  it("accepts a valid signature", async () => {
    const body = JSON.stringify({ event: "message.received" });
    const now = Math.floor(Date.now() / 1000);
    const result = await verifyBlooioRequest(signedRequest(body, now), { webhookSecret: SECRET });
    expect(result.body).toBe(body);
  });

  it("rejects a tampered body", async () => {
    const now = Math.floor(Date.now() / 1000);
    const req = new Request("https://example.com/eve/v1/blooio", {
      method: "POST",
      headers: { "x-blooio-signature": `t=${now},v1=${signBlooioPayload(SECRET, now, "{}")}` },
      body: JSON.stringify({ event: "message.received" }),
    });
    await expect(verifyBlooioRequest(req, { webhookSecret: SECRET })).rejects.toThrow(/mismatch/);
  });

  it("rejects a stale timestamp", async () => {
    const stale = Math.floor(Date.now() / 1000) - 1000;
    await expect(
      verifyBlooioRequest(signedRequest("{}", stale), {
        timestampToleranceSec: 300,
        webhookSecret: SECRET,
      }),
    ).rejects.toThrow(/tolerance/);
  });

  it("rejects a wrong secret", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      verifyBlooioRequest(signedRequest("{}", now, "whsec_other"), { webhookSecret: SECRET }),
    ).rejects.toThrow(/mismatch/);
  });
});
