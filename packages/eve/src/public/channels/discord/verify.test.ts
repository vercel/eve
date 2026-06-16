import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyDiscordRequest, verifyDiscordSignature } from "#public/channels/discord/verify.js";

function testKeys(): {
  privateKey: KeyObject;
  publicKeyHex: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey,
    publicKeyHex: Buffer.from(der).subarray(-32).toString("hex"),
  };
}

function signedRequest(input: {
  readonly body: string;
  readonly privateKey: KeyObject;
  readonly signatureOverride?: string;
  readonly timestamp?: string;
}): Request {
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(`${timestamp}${input.body}`), input.privateKey).toString(
    "hex",
  );
  return new Request("https://example.com/eve/v1/discord", {
    body: input.body,
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": input.signatureOverride ?? signature,
      "x-signature-timestamp": timestamp,
    },
    method: "POST",
  });
}

describe("verifyDiscordSignature", () => {
  it("verifies a Discord Ed25519 signature", () => {
    const { privateKey, publicKeyHex } = testKeys();
    const body = JSON.stringify({ type: 1 });
    const timestamp = "1700000000";
    const signature = sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString("hex");

    expect(
      verifyDiscordSignature({
        body,
        publicKey: publicKeyHex,
        signature,
        timestamp,
      }),
    ).toBe(true);
  });

  it("rejects malformed signatures", () => {
    const { publicKeyHex } = testKeys();

    expect(
      verifyDiscordSignature({
        body: "{}",
        publicKey: publicKeyHex,
        signature: "not-hex",
        timestamp: "1700000000",
      }),
    ).toBe(false);
  });
});

describe("verifyDiscordRequest", () => {
  it("returns the raw body for a verified request", async () => {
    const { privateKey, publicKeyHex } = testKeys();
    const body = JSON.stringify({ type: 1 });

    await expect(
      verifyDiscordRequest(signedRequest({ body, privateKey }), {
        publicKey: publicKeyHex,
      }),
    ).resolves.toBe(body);
  });

  it("throws when the signature does not match", async () => {
    const { privateKey, publicKeyHex } = testKeys();

    await expect(
      verifyDiscordRequest(
        signedRequest({
          body: JSON.stringify({ type: 1 }),
          privateKey,
          signatureOverride: "00".repeat(64),
        }),
        { publicKey: publicKeyHex },
      ),
    ).rejects.toThrow("signature mismatch");
  });

  it("rejects when the timestamp is older than the default 5-minute skew", async () => {
    const { privateKey, publicKeyHex } = testKeys();
    const now = Math.floor(Date.now() / 1000);

    await expect(
      verifyDiscordRequest(
        signedRequest({
          body: JSON.stringify({ type: 1 }),
          privateKey,
          timestamp: String(now - 60 * 6),
        }),
        { publicKey: publicKeyHex },
      ),
    ).rejects.toThrow("timestamp outside allowed skew");
  });

  it("rejects malformed timestamps", async () => {
    const { privateKey, publicKeyHex } = testKeys();

    await expect(
      verifyDiscordRequest(
        signedRequest({
          body: JSON.stringify({ type: 1 }),
          privateKey,
          timestamp: "not-a-number",
        }),
        { publicKey: publicKeyHex },
      ),
    ).rejects.toThrow("malformed timestamp");
  });

  it("accepts older timestamps when a wider skew is supplied", async () => {
    const { privateKey, publicKeyHex } = testKeys();
    const body = JSON.stringify({ type: 1 });
    const now = Math.floor(Date.now() / 1000);

    await expect(
      verifyDiscordRequest(signedRequest({ body, privateKey, timestamp: String(now - 60 * 30) }), {
        maxSkewSeconds: 60 * 60,
        publicKey: publicKeyHex,
      }),
    ).resolves.toBe(body);
  });

  it("delegates to a custom verifier when supplied", async () => {
    const request = new Request("https://example.com/eve/v1/discord", {
      body: "{}",
      method: "POST",
    });

    await expect(
      verifyDiscordRequest(request, {
        publicKey: undefined,
        webhookVerifier: () => '{"type":1}',
      }),
    ).resolves.toBe('{"type":1}');
  });
});
