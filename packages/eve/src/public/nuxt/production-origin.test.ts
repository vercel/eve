import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveProductionOrigin } from "./production-origin.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveProductionOrigin", () => {
  it("defaults to the local production port", () => {
    expect(resolveProductionOrigin()).toBe("http://127.0.0.1:4274");
  });

  it("defaults to the local production port for a blank one", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "   ");
    expect(resolveProductionOrigin()).toBe("http://127.0.0.1:4274");
  });

  it("reads a configured port", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "5000");
    expect(resolveProductionOrigin()).toBe("http://127.0.0.1:5000");
  });

  it("rejects a port that is not an integer in range", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "5000.5");
    expect(() => resolveProductionOrigin()).toThrow(/between 1 and 65535/);

    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "70000");
    expect(() => resolveProductionOrigin()).toThrow(/between 1 and 65535/);
  });

  it("prefers an origin override, reduced to its origin", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_ORIGIN", "  https://agent.example.com/root  ");
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "5000");
    expect(resolveProductionOrigin()).toBe("https://agent.example.com");
  });

  it("rejects an invalid origin override", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_ORIGIN", "not a url");
    expect(() => resolveProductionOrigin()).toThrow();
  });
});
