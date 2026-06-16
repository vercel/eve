import { describe, expect, it } from "vitest";

import { signLinearWebhookBody, verifyLinearRequest } from "#public/channels/linear/verify.js";

const SECRET = "linear-secret";

function signedRequest(
  input: {
    readonly payload?: Record<string, unknown>;
    readonly secret?: string;
    readonly signature?: string;
    readonly omitSignature?: boolean;
  } = {},
): Request {
  const body = JSON.stringify({
    type: "AgentSessionEvent",
    webhookTimestamp: Date.now(),
    ...input.payload,
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (!input.omitSignature) {
    headers["linear-signature"] =
      input.signature ?? signLinearWebhookBody(body, input.secret ?? SECRET);
  }
  return new Request("https://example.com/eve/v1/linear", { body, headers, method: "POST" });
}

describe("verifyLinearRequest", () => {
  it("returns the raw body when the signature and timestamp are valid", async () => {
    const req = signedRequest();

    await expect(verifyLinearRequest(req, { webhookSecret: SECRET })).resolves.toContain(
      '"AgentSessionEvent"',
    );
  });

  it("rejects when the signature was computed with another secret", async () => {
    const req = signedRequest({ secret: "wrong-secret" });

    await expect(verifyLinearRequest(req, { webhookSecret: SECRET })).rejects.toThrow(
      "signature mismatch",
    );
  });

  it("rejects when the signature header is missing", async () => {
    const req = signedRequest({ omitSignature: true });

    await expect(verifyLinearRequest(req, { webhookSecret: SECRET })).rejects.toThrow(
      "missing Linear-Signature",
    );
  });

  it("rejects stale webhook timestamps", async () => {
    const req = signedRequest({
      payload: { webhookTimestamp: Date.now() - 120_000 },
    });

    await expect(verifyLinearRequest(req, { webhookSecret: SECRET })).rejects.toThrow(
      "timestamp outside allowed skew",
    );
  });

  it("uses webhookVerifier instead of HMAC when supplied", async () => {
    const req = signedRequest({ secret: "wrong-secret" });

    await expect(
      verifyLinearRequest(req, {
        webhookSecret: SECRET,
        webhookVerifier: () => true,
      }),
    ).resolves.toContain('"AgentSessionEvent"');
  });
});
