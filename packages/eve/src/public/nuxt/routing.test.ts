import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EVE_NUXT_SERVICE_PREFIX,
  createEveVercelRewriteRoute,
  joinRoutePrefix,
  normalizeOrigin,
  normalizeRoutePrefix,
  readLocalProductionPort,
  resolveProductionTarget,
} from "./routing.js";

const EVE_PROTOCOL_PREFIX = "/eve/v1";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeRoutePrefix", () => {
  it("prepends a leading slash when missing", () => {
    expect(normalizeRoutePrefix("internal/eve")).toBe("/internal/eve");
  });

  it("strips trailing slashes", () => {
    expect(normalizeRoutePrefix("/internal/eve///")).toBe("/internal/eve");
  });

  it("keeps an already-normalized prefix unchanged", () => {
    expect(normalizeRoutePrefix(EVE_NUXT_SERVICE_PREFIX)).toBe(EVE_NUXT_SERVICE_PREFIX);
  });

  it("throws when the prefix resolves to the root route", () => {
    expect(() => normalizeRoutePrefix("/")).toThrow(/cannot resolve to the root route/);
    expect(() => normalizeRoutePrefix("")).toThrow(/cannot resolve to the root route/);
  });
});

describe("joinRoutePrefix", () => {
  it("joins with exactly one slash", () => {
    expect(joinRoutePrefix("/_eve_internal/eve", "/eve/v1")).toBe("/_eve_internal/eve/eve/v1");
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

describe("createEveVercelRewriteRoute", () => {
  it("rewrites the eve transport prefix onto the service prefix", () => {
    expect(createEveVercelRewriteRoute(EVE_NUXT_SERVICE_PREFIX)).toEqual({
      src: `^${EVE_PROTOCOL_PREFIX}/(.*)$`,
      dest: `${EVE_NUXT_SERVICE_PREFIX}${EVE_PROTOCOL_PREFIX}/$1`,
      check: true,
    });
  });

  it("honors a custom service prefix", () => {
    expect(createEveVercelRewriteRoute("/agent")).toEqual({
      src: `^${EVE_PROTOCOL_PREFIX}/(.*)$`,
      dest: `/agent${EVE_PROTOCOL_PREFIX}/$1`,
      check: true,
    });
  });
});

describe("resolveProductionTarget", () => {
  it("targets the private service prefix on Vercel", () => {
    vi.stubEnv("VERCEL", "1");
    expect(resolveProductionTarget(EVE_NUXT_SERVICE_PREFIX)).toBe(
      `${EVE_NUXT_SERVICE_PREFIX}${EVE_PROTOCOL_PREFIX}`,
    );
  });

  it("ignores a production origin override on Vercel", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("EVE_NUXT_PRODUCTION_ORIGIN", "https://agent.example.com");
    expect(resolveProductionTarget(EVE_NUXT_SERVICE_PREFIX)).toBe(
      `${EVE_NUXT_SERVICE_PREFIX}${EVE_PROTOCOL_PREFIX}`,
    );
  });

  it("uses a production origin override off Vercel", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_ORIGIN", "https://agent.example.com/root");
    expect(resolveProductionTarget(EVE_NUXT_SERVICE_PREFIX)).toBe(
      `https://agent.example.com${EVE_PROTOCOL_PREFIX}`,
    );
  });

  it("falls back to a local port off Vercel", () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "5000");
    expect(resolveProductionTarget(EVE_NUXT_SERVICE_PREFIX)).toBe(
      `http://127.0.0.1:5000${EVE_PROTOCOL_PREFIX}`,
    );
  });
});
