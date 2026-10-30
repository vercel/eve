import { describe, expect, test } from "vitest";

import {
  catalogSlugs,
  CONNECTION_CATALOG,
  effectiveProtocols,
  endpointForProtocol,
  getCatalogEntry,
  isValidConnectionSlug,
  SUPPORTED_PROTOCOLS,
} from "./catalog.js";
import { connectionEntries } from "@eve/catalog";

describe("catalog integrity", () => {
  test("every entry declares the endpoint for each protocol it lists", () => {
    for (const entry of CONNECTION_CATALOG) {
      for (const protocol of entry.protocols) {
        expect(endpointForProtocol(entry, protocol)).not.toBeNull();
      }
    }
  });

  test("every entry has a valid filesystem-derived slug", () => {
    for (const entry of CONNECTION_CATALOG) {
      expect(isValidConnectionSlug(entry.slug)).toBe(true);
    }
  });

  test("slugs are unique", () => {
    const slugs = catalogSlugs();
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("includes Browser Use with static API-key authentication", () => {
    expect(getCatalogEntry("browser-use")).toMatchObject({
      auth: {
        kind: "header",
        headers: [{ header: "x-browser-use-api-key", envVar: "BROWSER_USE_API_KEY" }],
      },
    });
  });

  test("gallery-only connections stay out of the scaffolder catalog", () => {
    const scaffoldable = connectionEntries().filter((entry) => entry.surfaces.scaffoldable);
    expect(CONNECTION_CATALOG.map((entry) => entry.slug)).toEqual(
      scaffoldable.map((entry) => entry.slug),
    );
    expect(connectionEntries().length).toBeGreaterThan(scaffoldable.length);
  });

  test("every Connect entry names the connector its scaffold references", () => {
    for (const entry of CONNECTION_CATALOG) {
      if (entry.auth.kind !== "connect") continue;
      expect(entry.auth.connector.trim()).not.toBe("");
    }
  });
});

describe("getCatalogEntry", () => {
  test("resolves a known slug", () => {
    expect(getCatalogEntry("linear")?.label).toBe("Linear");
  });

  test("returns undefined for an unknown slug", () => {
    expect(getCatalogEntry("nope")).toBeUndefined();
  });
});

describe("effectiveProtocols", () => {
  test("intersects declared protocols with supported ones", () => {
    expect(effectiveProtocols(["mcp"])).toEqual(["mcp"]);
    expect(effectiveProtocols(["openapi"])).toEqual([]);
    expect(effectiveProtocols(["mcp", "openapi"])).toEqual([...SUPPORTED_PROTOCOLS]);
  });

  test("falls back to the supported set when nothing is declared", () => {
    expect(effectiveProtocols(undefined)).toEqual([...SUPPORTED_PROTOCOLS]);
    expect(effectiveProtocols([])).toEqual([...SUPPORTED_PROTOCOLS]);
  });
});

describe("isValidConnectionSlug", () => {
  test("accepts lowercase kebab-case names up to 64 characters", () => {
    expect(isValidConnectionSlug("linear")).toBe(true);
    expect(isValidConnectionSlug("my-corp-2")).toBe(true);
    expect(isValidConnectionSlug(`a${"b".repeat(63)}`)).toBe(true);
  });

  test("rejects names the framework discovery grammar would reject", () => {
    expect(isValidConnectionSlug("")).toBe(false);
    expect(isValidConnectionSlug("Linear")).toBe(false);
    expect(isValidConnectionSlug("-bad")).toBe(false);
    expect(isValidConnectionSlug("has space")).toBe(false);
    // Underscores, leading digits, and >64 chars pass a laxer pattern but
    // fail `eve build` discovery — the scaffolder must reject them up front.
    expect(isValidConnectionSlug("my_corp")).toBe(false);
    expect(isValidConnectionSlug("2cool")).toBe(false);
    expect(isValidConnectionSlug(`a${"b".repeat(64)}`)).toBe(false);
  });
});
