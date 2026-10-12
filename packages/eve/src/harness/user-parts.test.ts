import { describe, expect, it } from "vitest";

import { userPartsOf } from "#harness/user-parts.js";

describe("the parts a delivery records", () => {
  it("links only http(s) files, and records an inline file's size instead of its bytes", () => {
    const parts = userPartsOf([
      { data: new URL("https://example.com/a.pdf"), mediaType: "application/pdf", type: "file" },
      { data: "data:text/plain;base64,aGVsbG8=", mediaType: "text/plain", type: "file" },
      { data: "aGVsbG8=", mediaType: "text/plain", type: "file" },
      { data: new Uint8Array([1, 2, 3]), mediaType: "image/png", type: "file" },
    ]);
    expect(parts[0]).toMatchObject({ kind: "file", url: "https://example.com/a.pdf" });
    for (const part of parts.slice(1)) {
      expect(part).toMatchObject({ kind: "file", unavailable: true });
      expect(part).not.toHaveProperty("url");
      expect(typeof (part as { size?: number }).size).toBe("number");
    }
  });
});
