import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveProductionOrigin } from "./production-origin.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveProductionOrigin", () => {
  it("defaults to the local production port", () => {
    expect(resolveProductionOrigin(0)).toBe("http://127.0.0.1:4274");
  });

  it("offsets the port per workspace member", () => {
    expect(resolveProductionOrigin(1)).toBe("http://127.0.0.1:4275");
  });

  it("defaults to the local production port for a blank one", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "   ");
    expect(resolveProductionOrigin(0)).toBe("http://127.0.0.1:4274");
  });

  it("reads a configured port", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "5000");
    expect(resolveProductionOrigin(2)).toBe("http://127.0.0.1:5002");
  });

  it("rejects a port that is not an integer in range", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "5000.5");
    expect(() => resolveProductionOrigin(0)).toThrow(/between 1 and 65535/);

    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "70000");
    expect(() => resolveProductionOrigin(0)).toThrow(/between 1 and 65535/);
  });

  it("rejects a port that the agent count pushes past the range", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "65535");
    expect(() => resolveProductionOrigin(1)).toThrow(/exceeds 65535/);
  });

  it("prefers an origin override, reduced to its origin", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_ORIGIN", "  https://agent.example.com/root  ");
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "5000");
    expect(resolveProductionOrigin(0)).toBe("https://agent.example.com");
  });

  it("rejects an invalid origin override", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_ORIGIN", "not a url");
    expect(() => resolveProductionOrigin(0)).toThrow();
  });
});
