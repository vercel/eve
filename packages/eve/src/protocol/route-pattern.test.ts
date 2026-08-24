import { describe, expect, it } from "vitest";

import {
  EveRoutePatternError,
  eveRoutePatternMatchesPath,
  eveRoutePatternsOverlap,
  parseEveRoutePattern,
} from "#protocol/route-pattern.js";

describe("eve route patterns", () => {
  it.each([
    ["/", "/", "/"],
    ["/hooks/", "/hooks", "/hooks"],
    ["/users/:userId/", "/users/:userId", "/users/:_"],
    ["/.well-known/oauth", "/.well-known/oauth", "/.well-known/oauth"],
  ])("canonicalizes %s", (path, canonicalPath, identityPattern) => {
    expect(parseEveRoutePattern(path)).toMatchObject({ canonicalPath, identityPattern });
  });

  it.each([
    "",
    "relative",
    "//",
    "/users//messages",
    "/users/:",
    "/users/:user-id",
    "/users/:naïve",
    "/users/:id?",
    "/users/:id+",
    "/users/:id*",
    "/users/:id(\\d+)",
    "/files/*",
    "/files/**",
    "/prefix:id",
    "/{optional}",
    "/escaped/\\:literal",
    "/foo(bar)",
    "/path?query",
    "/.",
    "/..",
  ])("rejects patterns outside the eve grammar: %s", (path) => {
    expect(() => parseEveRoutePattern(path)).toThrow(EveRoutePatternError);
  });

  it("compares route match spaces without depending on parameter names", () => {
    expect(eveRoutePatternsOverlap("/users/:id", "/users/:name/")).toBe(true);
    expect(eveRoutePatternsOverlap("/users/current", "/users/:id")).toBe(true);
    expect(eveRoutePatternsOverlap("/users/current", "/teams/:id")).toBe(false);
    expect(eveRoutePatternsOverlap("/users/:id", "/users/:id/messages")).toBe(false);
  });

  it("matches concrete request paths with the same trailing-slash semantics", () => {
    expect(eveRoutePatternMatchesPath("/users/:id", "/users/123/")).toBe(true);
    expect(eveRoutePatternMatchesPath("/users/:id", "/users/")).toBe(false);
    expect(eveRoutePatternMatchesPath("/users/current", "/users/other")).toBe(false);
  });
});
