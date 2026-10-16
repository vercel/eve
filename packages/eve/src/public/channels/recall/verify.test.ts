import { describe, expect, it } from "vitest";

import { signRecallWebhook, verifyRecallWebhook } from "#public/channels/recall/verify.js";

const SECRET = `whsec_${Buffer.from("recall-test-secret").toString("base64")}`;
const NOW = 1_800_000_000_000;
const PAYLOAD = '{"event":"transcript.data"}';

function headers(input: {
  readonly prefix?: "webhook" | "svix";
  readonly secret?: string;
  readonly timestamp?: number;
  readonly signature?: string;
}): Headers {
  const prefix = input.prefix ?? "webhook";
  const timestamp = input.timestamp ?? NOW / 1000;
  const signature =
    input.signature ??
    `v1,${signRecallWebhook({ id: "msg_1", payload: PAYLOAD, secret: input.secret ?? SECRET, timestamp })}`;
  return new Headers({
    [`${prefix}-id`]: "msg_1",
    [`${prefix}-signature`]: signature,
    [`${prefix}-timestamp`]: String(timestamp),
  });
}

describe("verifyRecallWebhook", () => {
  it.each([
    ["a workspace-signed delivery", headers({}), true],
    ["a legacy Svix-signed delivery", headers({ prefix: "svix" }), true],
    ["another secret's signature", headers({ secret: `whsec_${btoa("other")}` }), false],
    ["a delivery older than five minutes", headers({ timestamp: NOW / 1000 - 301 }), false],
    ["a non-v1 signature", headers({ signature: "v2,abc" }), false],
  ])("for %s returns %s", (_name, signed, expected) => {
    expect(
      verifyRecallWebhook({ headers: signed, now: NOW, payload: PAYLOAD, secret: SECRET }),
    ).toBe(expected);
  });

  it("accepts any listed signature, so a rotated secret keeps verifying", () => {
    const valid = headers({}).get("webhook-signature")!;
    const rotated = headers({ signature: `v1,${btoa("stale")} ${valid}` });

    expect(
      verifyRecallWebhook({ headers: rotated, now: NOW, payload: PAYLOAD, secret: SECRET }),
    ).toBe(true);
  });

  it("rejects a body that differs from the signed one", () => {
    expect(
      verifyRecallWebhook({
        headers: headers({}),
        now: NOW,
        payload: `${PAYLOAD} `,
        secret: SECRET,
      }),
    ).toBe(false);
  });
});
