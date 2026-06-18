import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveAgentPhoneWebhookSecret,
  signAgentPhoneRequest,
  verifyAgentPhoneRequest,
} from "./verify.js";

function sign(secret: string, timestamp: string, body: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `sha256=${digest}`;
}

function makeRequest(body: string, headers: Record<string, string>): Request {
  return new Request("https://example.com/eve/v1/agentphone/webhooks", {
    method: "POST",
    headers,
    body,
  });
}

describe("signAgentPhoneRequest", () => {
  it("produces sha256=<hex> format", () => {
    const result = signAgentPhoneRequest({
      body: '{"event":"agent.message"}',
      secret: "whsec_test",
      timestamp: "1700000000",
    });
    expect(result).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("matches manual HMAC-SHA256", () => {
    const secret = "whsec_test";
    const timestamp = "1700000000";
    const body = '{"event":"agent.message"}';
    const expected = sign(secret, timestamp, body);
    const actual = signAgentPhoneRequest({ body, secret, timestamp });
    expect(actual).toBe(expected);
  });
});

describe("resolveAgentPhoneWebhookSecret", () => {
  afterEach(() => {
    delete process.env.AGENTPHONE_WEBHOOK_SECRET;
  });

  it("uses the provided string", async () => {
    expect(await resolveAgentPhoneWebhookSecret("whsec_direct")).toBe("whsec_direct");
  });

  it("calls a function provider", async () => {
    const provider = vi.fn().mockResolvedValue("whsec_async");
    expect(await resolveAgentPhoneWebhookSecret(provider)).toBe("whsec_async");
    expect(provider).toHaveBeenCalledOnce();
  });

  it("falls back to AGENTPHONE_WEBHOOK_SECRET env", async () => {
    process.env.AGENTPHONE_WEBHOOK_SECRET = "whsec_env";
    expect(await resolveAgentPhoneWebhookSecret()).toBe("whsec_env");
  });

  it("throws when no secret is available", async () => {
    await expect(resolveAgentPhoneWebhookSecret()).rejects.toThrow(
      "AGENTPHONE_WEBHOOK_SECRET is required.",
    );
  });
});

describe("verifyAgentPhoneRequest", () => {
  const secret = "whsec_test_secret";

  it("verifies a valid request", async () => {
    const body = '{"event":"agent.message","data":{"from":"+15551234567"}}';
    const now = Math.floor(Date.now() / 1000);
    const timestamp = String(now);
    const signature = sign(secret, timestamp, body);

    const request = makeRequest(body, {
      "x-webhook-signature": signature,
      "x-webhook-timestamp": timestamp,
    });

    const result = await verifyAgentPhoneRequest(request, { webhookSecret: secret });
    expect(result.body).toBe(body);
    expect(result.payload).toEqual(JSON.parse(body));
  });

  it("rejects missing signature header", async () => {
    const request = makeRequest("{}", {
      "x-webhook-timestamp": String(Math.floor(Date.now() / 1000)),
    });

    await expect(verifyAgentPhoneRequest(request, { webhookSecret: secret })).rejects.toThrow(
      "missing X-Webhook-Signature",
    );
  });

  it("rejects missing timestamp header", async () => {
    const request = makeRequest("{}", {
      "x-webhook-signature": "sha256=abc",
    });

    await expect(verifyAgentPhoneRequest(request, { webhookSecret: secret })).rejects.toThrow(
      "missing X-Webhook-Timestamp",
    );
  });

  it("rejects a timestamp outside the replay window", async () => {
    const body = "{}";
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const signature = sign(secret, oldTimestamp, body);

    const request = makeRequest(body, {
      "x-webhook-signature": signature,
      "x-webhook-timestamp": oldTimestamp,
    });

    await expect(verifyAgentPhoneRequest(request, { webhookSecret: secret })).rejects.toThrow(
      "outside replay window",
    );
  });

  it("rejects an invalid signature", async () => {
    const body = "{}";
    const timestamp = String(Math.floor(Date.now() / 1000));

    const request = makeRequest(body, {
      "x-webhook-signature":
        "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      "x-webhook-timestamp": timestamp,
    });

    await expect(verifyAgentPhoneRequest(request, { webhookSecret: secret })).rejects.toThrow(
      "signature mismatch",
    );
  });
});
