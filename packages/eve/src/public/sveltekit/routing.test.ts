import { describe, expect, it } from "vitest";

import {
  EVE_SVELTEKIT_SERVICE_PREFIX,
  createEveVercelRewrite,
  joinRoutePrefix,
  normalizeOrigin,
  normalizeRoutePrefix,
} from "./routing.js";

const EVE_PROTOCOL_PREFIX = "/eve/v1";

describe("normalizeRoutePrefix", () => {
  it("prepends a leading slash when missing", () => {
    expect(normalizeRoutePrefix("internal/eve")).toBe("/internal/eve");
  });

  it("strips trailing slashes", () => {
    expect(normalizeRoutePrefix("/internal/eve///")).toBe("/internal/eve");
  });

  it("keeps an already-normalized prefix unchanged", () => {
    expect(normalizeRoutePrefix(EVE_SVELTEKIT_SERVICE_PREFIX)).toBe(EVE_SVELTEKIT_SERVICE_PREFIX);
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

describe("createEveVercelRewrite", () => {
  it("rewrites the eve transport prefix onto the service prefix", () => {
    expect(createEveVercelRewrite(EVE_SVELTEKIT_SERVICE_PREFIX)).toEqual({
      source: `${EVE_PROTOCOL_PREFIX}/:path*`,
      destination: `${EVE_SVELTEKIT_SERVICE_PREFIX}${EVE_PROTOCOL_PREFIX}/:path*`,
    });
  });

  it("honors a custom service prefix", () => {
    expect(createEveVercelRewrite("/agent")).toEqual({
      source: `${EVE_PROTOCOL_PREFIX}/:path*`,
      destination: `/agent${EVE_PROTOCOL_PREFIX}/:path*`,
    });
  });
});
