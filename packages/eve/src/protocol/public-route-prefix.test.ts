import { afterEach, describe, expect, it, vi } from "vitest";

import {
  prefixFrameworkCallbackPath,
  resolveEvePublicRoutePrefix,
} from "#protocol/public-route-prefix.js";

describe("resolveEvePublicRoutePrefix", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an empty string when the env var is unset", () => {
    vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "");
    expect(resolveEvePublicRoutePrefix()).toBe("");
  });

  it("returns an empty string when the env var is whitespace", () => {
    vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "   ");
    expect(resolveEvePublicRoutePrefix()).toBe("");
  });

  it("returns the configured prefix", () => {
    vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "/eve/agents/researcher");
    expect(resolveEvePublicRoutePrefix()).toBe("/eve/agents/researcher");
  });

  it("strips a trailing slash so it joins cleanly with an absolute path", () => {
    vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "/eve/agents/researcher/");
    expect(resolveEvePublicRoutePrefix()).toBe("/eve/agents/researcher");
  });
});

describe("prefixFrameworkCallbackPath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prepends the prefix to a framework callback path", () => {
    vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "/eve/agents/researcher");
    expect(prefixFrameworkCallbackPath("/eve/v1/callback/tok123")).toBe(
      "/eve/agents/researcher/eve/v1/callback/tok123",
    );
  });

  it("is a no-op for a single-agent mount (no prefix)", () => {
    vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "");
    expect(prefixFrameworkCallbackPath("/eve/v1/callback/tok123")).toBe("/eve/v1/callback/tok123");
  });
});
