import { describe, expect, it } from "vitest";

import { normalizePublicRoutePrefix } from "#shared/public-route-prefix.js";

describe("normalizePublicRoutePrefix", () => {
  it("returns undefined for values resolving to the root route", () => {
    expect(normalizePublicRoutePrefix(undefined)).toBeUndefined();
    expect(normalizePublicRoutePrefix("")).toBeUndefined();
    expect(normalizePublicRoutePrefix("   ")).toBeUndefined();
    expect(normalizePublicRoutePrefix("/")).toBeUndefined();
    expect(normalizePublicRoutePrefix("//")).toBeUndefined();
  });

  it("adds the leading slash", () => {
    expect(normalizePublicRoutePrefix("eve/support")).toBe("/eve/support");
  });

  it("strips trailing slashes", () => {
    expect(normalizePublicRoutePrefix("/eve/support/")).toBe("/eve/support");
    expect(normalizePublicRoutePrefix("/eve/support//")).toBe("/eve/support");
  });

  it("keeps an already-normalized prefix unchanged", () => {
    expect(normalizePublicRoutePrefix("/eve/support")).toBe("/eve/support");
  });
});
