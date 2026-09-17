import { describe, expect, it } from "vitest";

import { joinEveRoutePath, normalizePublicEveRoutePath } from "#shared/eve-route-path.js";

describe("joinEveRoutePath", () => {
  it("maps an internal route onto a compact named-agent mount", () => {
    expect(joinEveRoutePath("/eve/support", "/eve/v1/session")).toBe("/eve/support/v1/session");
  });

  it("appends an internal route to ordinary mounts unchanged", () => {
    expect(joinEveRoutePath("/api/support", "/eve/v1/session")).toBe("/api/support/eve/v1/session");
  });

  it("does not duplicate the protocol base", () => {
    expect(joinEveRoutePath("/eve/support/v1", "/eve/v1/session")).toBe("/eve/support/v1/session");
  });
});

describe("normalizePublicEveRoutePath", () => {
  it("maps a compact named-agent route to its internal route", () => {
    expect(normalizePublicEveRoutePath("/eve/support/v1/callback/token")).toBe(
      "/eve/v1/callback/token",
    );
  });

  it("preserves ordinary and internal routes", () => {
    expect(normalizePublicEveRoutePath("/api/support/v1/callback/token")).toBe(
      "/api/support/v1/callback/token",
    );
    expect(normalizePublicEveRoutePath("/eve/v1/callback/token")).toBe("/eve/v1/callback/token");
  });
});
