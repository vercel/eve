import { describe, expect, it } from "vitest";

import { signResendPayload, verifyResendSignature } from "#public/channels/resend/verify.js";

const SECRET = `whsec_${Buffer.from("resend-test-secret").toString("base64")}`;
const NOW = 1_800_000_000;

function headers(body: string, overrides: Record<string, string> = {}): Headers {
  const id = "msg_1";
  const timestamp = String(NOW);
  return new Headers({
    "svix-id": id,
    "svix-signature": `v1,${signResendPayload({ body, id, secret: SECRET, timestamp })}`,
    "svix-timestamp": timestamp,
    ...overrides,
  });
}

describe("verifyResendSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = '{"type":"email.received"}';
    expect(
      verifyResendSignature({ body, headers: headers(body), nowSeconds: NOW, secret: SECRET }),
    ).toBe(true);
  });

  it("accepts when any of several signatures matches, as during secret rotation", () => {
    const body = "{}";
    const signed = headers(body);
    signed.set("svix-signature", `v1,c3RhbGU= ${signed.get("svix-signature")}`);
    expect(verifyResendSignature({ body, headers: signed, nowSeconds: NOW, secret: SECRET })).toBe(
      true,
    );
  });

  it("rejects a tampered body", () => {
    expect(
      verifyResendSignature({
        body: '{"type":"other"}',
        headers: headers('{"type":"email.received"}'),
        nowSeconds: NOW,
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects a signature outside the five-minute window", () => {
    const body = "{}";
    expect(
      verifyResendSignature({
        body,
        headers: headers(body),
        nowSeconds: NOW + 301,
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects a request without Svix headers", () => {
    expect(
      verifyResendSignature({
        body: "{}",
        headers: new Headers(),
        nowSeconds: NOW,
        secret: SECRET,
      }),
    ).toBe(false);
  });
});
