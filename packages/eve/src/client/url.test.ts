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

  it("preserves host query parameters on agent routes", () => {
    expect(
      createClientUrl(
        "https://agent.example.com?x-vercel-protection-bypass=secret",
        "/eve/v1/session",
      ),
    ).toBe("https://agent.example.com/eve/v1/session?x-vercel-protection-bypass=secret");
  });

  it("merges route query parameters over host query parameters", () => {
    expect(
      createClientUrl(
        "https://agent.example.com?token=secret&startIndex=stale",
        "/eve/v1/session/123/stream",
        { startIndex: "4" },
      ),
    ).toBe("https://agent.example.com/eve/v1/session/123/stream?token=secret&startIndex=4");
  });

  it("supports same-origin proxy prefixes", () => {
    expect(createClientUrl("/api", "/eve/v1/session")).toBe("/api/eve/v1/session");
  });

  it("adds query parameters without forcing an absolute URL", () => {
    expect(createClientUrl("/api", "/eve/v1/session/123/stream", { startIndex: "4" })).toBe(
      "/api/eve/v1/session/123/stream?startIndex=4",
    );
  });

  it("preserves query parameters on same-origin proxy prefixes", () => {
    expect(createClientUrl("/api?token=secret", "/eve/v1/session")).toBe(
      "/api/eve/v1/session?token=secret",
    );
  });

  it("splits a query string embedded in the route path instead of encoding it", () => {
    expect(
      createClientUrl(
        "https://agent.example.com",
        "/eve/v1/connections/auth-probe/callback/attempt_1/wrun_1%3Aauth?code=ok",
      ),
    ).toBe(
      "https://agent.example.com/eve/v1/connections/auth-probe/callback/attempt_1/wrun_1%3Aauth?code=ok",
    );
  });

  it("splits embedded route queries on same-origin proxy prefixes", () => {
    expect(createClientUrl("/api", "/eve/v1/session/123/stream?startIndex=4")).toBe(
      "/api/eve/v1/session/123/stream?startIndex=4",
    );
  });

  it("prefers explicit search parameters over embedded route queries", () => {
    expect(
      createClientUrl("https://agent.example.com", "/eve/v1/session/123/stream?startIndex=stale", {
        startIndex: "4",
      }),
    ).toBe("https://agent.example.com/eve/v1/session/123/stream?startIndex=4");
  });
});
