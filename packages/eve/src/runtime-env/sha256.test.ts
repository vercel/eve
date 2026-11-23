import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { toBase64Url, toHex } from "#shared/bytes.js";
import { sha256 } from "./sha256.web.ts";

describe("the pure SHA-256 the browser build uses", () => {
  it("matches node:crypto, including multi-block and non-ASCII input", () => {
    for (const input of [
      "",
      "abc",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(1000),
      "héllo ✓ 🎉",
    ]) {
      const expected = createHash("sha256").update(input).digest();
      expect(toHex(sha256(input))).toBe(expected.toString("hex"));
      expect(toBase64Url(sha256(new TextEncoder().encode(input)))).toBe(
        expected.toString("base64url"),
      );
    }
  });

  it("writes unpadded base64url like Node for every remainder", () => {
    for (const bytes of [[], [1], [1, 2], [1, 2, 3], [255, 254, 253, 252]]) {
      const data = new Uint8Array(bytes);
      expect(toBase64Url(data)).toBe(Buffer.from(data).toString("base64url"));
    }
  });
});
