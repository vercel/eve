import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import {
  readWebhookJson,
  readWebhookSecret,
  verifyWebhookSecret,
} from "./request.ts";

test("reads the direct webhook secret header", () => {
  const headers = new Headers({
    authorization: "Bearer fallback",
    "x-sre-webhook-secret": "direct",
  });

  assert.equal(readWebhookSecret(headers), "direct");
});

test("reads a bearer token", () => {
  assert.equal(
    readWebhookSecret(new Headers({ authorization: "Bearer secret" })),
    "secret"
  );
});

test("rejects missing, malformed, and mismatched secrets", () => {
  assert.equal(verifyWebhookSecret(new Headers(), "secret"), false);
  assert.equal(
    verifyWebhookSecret(
      new Headers({ authorization: "Basic secret" }),
      "secret"
    ),
    false
  );
  assert.equal(
    verifyWebhookSecret(
      new Headers({ "x-sre-webhook-secret": "wrong" }),
      "secret"
    ),
    false
  );
  assert.equal(
    verifyWebhookSecret(
      new Headers({ "x-sre-webhook-secret": "secret" }),
      undefined
    ),
    false
  );
});

test("accepts matching secrets", () => {
  assert.equal(
    verifyWebhookSecret(
      new Headers({ "x-sre-webhook-secret": "secret" }),
      "secret"
    ),
    true
  );
});

describe("readWebhookJson", () => {
  it("rejects unauthorized requests", async () => {
    const result = await readWebhookJson(
      new Request("https://example.com", { method: "POST" }),
      "secret"
    );
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.response.status, 401);
  });

  it("rejects invalid JSON", async () => {
    const result = await readWebhookJson(
      new Request("https://example.com", {
        body: "not-json",
        headers: {
          "content-type": "text/plain",
          "x-sre-webhook-secret": "secret",
        },
        method: "POST",
      }),
      "secret"
    );
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.response.status, 400);
  });

  it("returns parsed JSON when authorized", async () => {
    const result = await readWebhookJson(
      new Request("https://example.com", {
        body: JSON.stringify({ title: "ok" }),
        headers: {
          "content-type": "application/json",
          "x-sre-webhook-secret": "secret",
        },
        method: "POST",
      }),
      "secret"
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.raw, { title: "ok" });
  });
});
