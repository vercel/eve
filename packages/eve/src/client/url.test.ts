import { describe, expect, it } from "vitest";

import { createClientUrl } from "#client/url.js";

describe("createClientUrl", () => {
  it("preserves absolute origins", () => {
    expect(createClientUrl("https://agent.example.com", "/eve/v1/session")).toBe(
      "https://agent.example.com/eve/v1/session",
    );
  });

  it("preserves absolute base paths for proxied agents", () => {
    expect(createClientUrl("https://app.example.com/api", "/eve/v1/session")).toBe(
      "https://app.example.com/api/eve/v1/session",
    );
  });

  it("supports same-origin proxy prefixes", () => {
    expect(createClientUrl("/api", "/eve/v1/session")).toBe("/api/eve/v1/session");
  });

  it("adds query parameters without forcing an absolute URL", () => {
    expect(createClientUrl("/api", "/eve/v1/session/123/stream", { startIndex: "4" })).toBe(
      "/api/eve/v1/session/123/stream?startIndex=4",
    );
  });
});
