import { describe, expect, it } from "vitest";

import { normalizeOrigin } from "./routing.js";

describe("normalizeOrigin", () => {
  it("reduces a URL with a path to its origin", () => {
    expect(normalizeOrigin("https://agent.example.com/root/path")).toBe(
      "https://agent.example.com",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeOrigin("  http://127.0.0.1:49152/  ")).toBe("http://127.0.0.1:49152");
  });

  it("throws on an invalid origin", () => {
    expect(() => normalizeOrigin("not a url")).toThrow();
  });
});
