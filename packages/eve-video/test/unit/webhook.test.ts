import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";

import { verifyGatewayWebhookSignature } from "../../extension/lib/webhook.ts";

function sign(secret: string, timestamp: number, body: string | Uint8Array): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestamp}.`, "utf8");
  if (typeof body === "string") {
    hmac.update(body, "utf8");
  } else {
    hmac.update(body);
  }
  return hmac.digest("hex");
}

describe("verifyGatewayWebhookSignature", () => {
  const secret = "whsec_test_signing_key";
  const nowSeconds = 1_700_000_000;
  const payload = JSON.stringify({ event: "video.completed", jobId: "job_123" });

  test("verifies valid signatures for both string and Uint8Array raw bodies", () => {
    const digest = sign(secret, nowSeconds, payload);
    const header = `t=${nowSeconds},v1=${digest}`;

    assert.equal(
      verifyGatewayWebhookSignature({
        header,
        rawBody: payload,
        secret,
        nowSeconds,
      }),
      true,
    );

    assert.equal(
      verifyGatewayWebhookSignature({
        header: `t=${nowSeconds},v1=${digest.toUpperCase()}`,
        rawBody: new TextEncoder().encode(payload),
        secret,
        nowSeconds,
      }),
      true,
    );
  });

  test("supports multiple v1 digests for signing key rotation", () => {
    const oldDigest = sign("whsec_old_key", nowSeconds, payload);
    const currentDigest = sign(secret, nowSeconds, payload);

    assert.equal(
      verifyGatewayWebhookSignature({
        header: `t=${nowSeconds},v1=${oldDigest},v1=${currentDigest}`,
        rawBody: payload,
        secret,
        nowSeconds,
      }),
      true,
    );

    assert.equal(
      verifyGatewayWebhookSignature({
        header: `t=${nowSeconds},v1=${currentDigest},v1=${oldDigest}`,
        rawBody: payload,
        secret,
        nowSeconds,
      }),
      true,
    );
  });

  test("rejects tampered body, wrong secret, and empty secret", () => {
    const digest = sign(secret, nowSeconds, payload);
    const header = `t=${nowSeconds},v1=${digest}`;

    assert.equal(
      verifyGatewayWebhookSignature({
        header,
        rawBody: `${payload} `,
        secret,
        nowSeconds,
      }),
      false,
    );

    assert.equal(
      verifyGatewayWebhookSignature({
        header,
        rawBody: payload,
        secret: "whsec_wrong_key",
        nowSeconds,
      }),
      false,
    );

    assert.equal(
      verifyGatewayWebhookSignature({
        header,
        rawBody: payload,
        secret: "",
        nowSeconds,
      }),
      false,
    );
  });

  test("enforces replay window for expired and future timestamps", () => {
    const exactPast = nowSeconds - 300;
    assert.equal(
      verifyGatewayWebhookSignature({
        header: `t=${exactPast},v1=${sign(secret, exactPast, payload)}`,
        rawBody: payload,
        secret,
        nowSeconds,
      }),
      true,
    );

    const expired = nowSeconds - 301;
    assert.equal(
      verifyGatewayWebhookSignature({
        header: `t=${expired},v1=${sign(secret, expired, payload)}`,
        rawBody: payload,
        secret,
        nowSeconds,
      }),
      false,
    );

    const futurePastSkew = nowSeconds + 301;
    assert.equal(
      verifyGatewayWebhookSignature({
        header: `t=${futurePastSkew},v1=${sign(secret, futurePastSkew, payload)}`,
        rawBody: payload,
        secret,
        nowSeconds,
      }),
      false,
    );

    const customSkewPast = nowSeconds - 31;
    assert.equal(
      verifyGatewayWebhookSignature({
        header: `t=${customSkewPast},v1=${sign(secret, customSkewPast, payload)}`,
        rawBody: payload,
        secret,
        maxAgeSeconds: 30,
        nowSeconds,
      }),
      false,
    );
  });

  test("rejects malformed headers and invalid hex digests", () => {
    const digest = sign(secret, nowSeconds, payload);
    const malformedHeaders = [
      "",
      "   ",
      `v1=${digest}`,
      `t=${nowSeconds}`,
      `t=${nowSeconds},v1=`,
      `t=,v1=${digest}`,
      `t=abc,v1=${digest}`,
      `t=${nowSeconds},t=${nowSeconds},v1=${digest}`,
      `t=${nowSeconds},invalidpart,v1=${digest}`,
      `t=${nowSeconds},v1=${digest.slice(0, -2)}`,
      `t=${nowSeconds},v1=${"z".repeat(64)}`,
      `t=${nowSeconds},v2=${digest}`,
    ];

    for (const header of malformedHeaders) {
      assert.equal(
        verifyGatewayWebhookSignature({
          header,
          rawBody: payload,
          secret,
          nowSeconds,
        }),
        false,
        `expected false for header: ${header}`,
      );
    }
  });
});
