import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "./sha256.js";

describe("sha256Hex", () => {
  it("digests as node:crypto does", () => {
    const long = "x".repeat(10_000);
    for (const input of [
      "",
      "abc",
      "session:1/turn:2",
      "héllo ✓",
      long,
      new Uint8Array([0, 255, 7]),
    ]) {
      expect(sha256Hex(input)).toBe(createHash("sha256").update(input).digest("hex"));
    }
  });
});
