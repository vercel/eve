import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveProductionTarget } from "./production-origin.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const AGENT = { portOffset: 0, publicPrefix: "/eve/v1" };

describe("resolveProductionTarget", () => {
  it("defaults to the local production port", () => {
    expect(resolveProductionTarget(AGENT)).toBe("http://127.0.0.1:4274/eve/v1");
  });

  it("offsets the port per workspace member and targets /eve/v1", () => {
    expect(resolveProductionTarget({ portOffset: 1, publicPrefix: "/eve/b/v1" })).toBe(
      "http://127.0.0.1:4275/eve/v1",
    );
  });

  it("defaults to the local production port for a blank one", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "   ");
    expect(resolveProductionTarget(AGENT)).toBe("http://127.0.0.1:4274/eve/v1");
  });

  it("reads a configured port", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "5000");
    expect(resolveProductionTarget({ portOffset: 2, publicPrefix: "/eve/c/v1" })).toBe(
      "http://127.0.0.1:5002/eve/v1",
    );
  });

  it("rejects a port that is not an integer in range", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "5000.5");
    expect(() => resolveProductionTarget(AGENT)).toThrow(/between 1 and 65535/);

    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "70000");
    expect(() => resolveProductionTarget(AGENT)).toThrow(/between 1 and 65535/);
  });

  it("rejects a port that the agent count pushes past the range", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "65535");
    expect(() => resolveProductionTarget({ portOffset: 1, publicPrefix: "/eve/b/v1" })).toThrow(
      /exceeds 65535/,
    );
  });

  it("prefers an origin override, reduced to its origin", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_ORIGIN", "  https://agent.example.com/root  ");
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "5000");
    expect(resolveProductionTarget(AGENT)).toBe("https://agent.example.com/eve/v1");
  });

  it("keeps each workspace member's prefix on an origin override", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_ORIGIN", "https://agent.example.com");
    expect(resolveProductionTarget({ portOffset: 0, publicPrefix: "/eve/a/v1" })).toBe(
      "https://agent.example.com/eve/a/v1",
    );
    expect(resolveProductionTarget({ portOffset: 1, publicPrefix: "/eve/b/v1" })).toBe(
      "https://agent.example.com/eve/b/v1",
    );
  });

  it("rejects an invalid origin override", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_ORIGIN", "not a url");
    expect(() => resolveProductionTarget(AGENT)).toThrow();
  });
});
