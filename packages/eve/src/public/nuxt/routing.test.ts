import { afterEach, describe, expect, it, vi } from "vitest";

import {
  joinRoutePrefix,
  normalizeOrigin,
  readLocalProductionPort,
  resolveProductionTarget,
} from "./routing.js";

const EVE_PROTOCOL_PREFIX = "/eve/v1";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("joinRoutePrefix", () => {
  it("joins with exactly one slash", () => {
    expect(joinRoutePrefix("http://127.0.0.1:4274", "eve/v1")).toBe("http://127.0.0.1:4274/eve/v1");
  });

  it("collapses duplicate slashes at the boundary", () => {
    expect(joinRoutePrefix("/prefix/", "//path")).toBe("/prefix/path");
  });

  it("joins onto an absolute origin", () => {
    expect(joinRoutePrefix("http://127.0.0.1:4274", "/eve/v1")).toBe(
      "http://127.0.0.1:4274/eve/v1",
    );
  });
});

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

describe("readLocalProductionPort", () => {
  it("defaults to 4274 when unset", () => {
    expect(readLocalProductionPort()).toBe(4274);
  });

  it("defaults to 4274 for blank values", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "   ");
    expect(readLocalProductionPort()).toBe(4274);
  });

  it("reads a configured port", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "5000");
    expect(readLocalProductionPort()).toBe(5000);
  });

  it("rejects non-integer values", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "5000.5");
    expect(() => readLocalProductionPort()).toThrow(/between 1 and 65535/);
  });

  it("rejects out-of-range ports", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "70000");
    expect(() => readLocalProductionPort()).toThrow(/between 1 and 65535/);
  });
});

describe("resolveProductionTarget", () => {
  it("uses a production origin override", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_ORIGIN", "https://agent.example.com/root");
    expect(resolveProductionTarget()).toBe(`https://agent.example.com${EVE_PROTOCOL_PREFIX}`);
  });

  it("falls back to a local port", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "5000");
    expect(resolveProductionTarget()).toBe(`http://127.0.0.1:5000${EVE_PROTOCOL_PREFIX}`);
  });
});
