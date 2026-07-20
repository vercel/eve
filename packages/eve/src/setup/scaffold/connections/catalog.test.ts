import { describe, expect, test } from "vitest";

import {
  canonicalConnectorNameForEntry,
  catalogSlugs,
  CONNECTION_CATALOG,
  connectorServiceForEntry,
  effectiveProtocols,
  endpointForProtocol,
  getCatalogEntry,
  isValidConnectionSlug,
  mcpServiceHost,
  SUPPORTED_PROTOCOLS,
} from "./catalog.js";
import { connectionEntries } from "@vercel/eve-catalog";

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

  test("every curated entry authenticates via Connect", () => {
    for (const entry of CONNECTION_CATALOG) {
      expect(entry.auth.kind).toBe("connect");
    }
  });

  test("gallery-only connections stay out of the scaffolder catalog", () => {
    const scaffoldable = connectionEntries().filter((entry) => entry.surfaces.scaffoldable);
    expect(CONNECTION_CATALOG.map((entry) => entry.slug)).toEqual(
      scaffoldable.map((entry) => entry.slug),
    );
    expect(connectionEntries().length).toBeGreaterThan(scaffoldable.length);
  });

  test("every Connect entry resolves a `vercel connect create` service", () => {
    for (const entry of CONNECTION_CATALOG) {
      expect(connectorServiceForEntry(entry)).toBeTruthy();
      expect(canonicalConnectorNameForEntry(entry)).toBeTruthy();
    }
  });
});

describe("connectorServiceForEntry", () => {
  test("prefers the explicit service over the MCP endpoint", () => {
    expect(
      connectorServiceForEntry({
        mcp: { url: "https://mcp.example.com/sse" },
        auth: { kind: "connect", connector: "x", service: "explicit.example" },
      }),
    ).toBe("explicit.example");
  });

  test("falls back to the MCP host when no service is set", () => {
    expect(
      connectorServiceForEntry({
        mcp: { url: "https://mcp.example.com/sse" },
        auth: { kind: "connect", connector: "x" },
      }),
    ).toBe("mcp.example.com");
  });

  test("returns undefined for non-connect auth", () => {
    expect(
      connectorServiceForEntry({ auth: { kind: "bearer-env", envVar: "TOKEN" } }),
    ).toBeUndefined();
  });
});

describe("canonicalConnectorNameForEntry", () => {
  test("uses the configured connector name without inferring a UID namespace", () => {
    expect(canonicalConnectorNameForEntry(getCatalogEntry("notion")!)).toBe("notion");
    expect(
      canonicalConnectorNameForEntry({
        auth: { kind: "connect", connector: "custom", service: "mcp.example.com/mcp" },
      }),
    ).toBe("custom");
  });
});

describe("curated Connect services", () => {
  test("uses the provider's managed service identifier", () => {
    expect(connectorServiceForEntry(getCatalogEntry("linear")!)).toBe("mcp.linear.app");
    expect(connectorServiceForEntry(getCatalogEntry("notion")!)).toBe("mcp.notion.com");
    expect(connectorServiceForEntry(getCatalogEntry("datadog")!)).toBe("mcp.datadoghq.com");
    expect(connectorServiceForEntry(getCatalogEntry("honeycomb")!)).toBe("mcp.honeycomb.io");
  });
});

describe("mcpServiceHost", () => {
  test("extracts the host from a URL", () => {
    expect(mcpServiceHost("https://mcp.linear.app/mcp")).toBe("mcp.linear.app");
  });

  test("returns undefined for missing or unparseable input", () => {
    expect(mcpServiceHost(undefined)).toBeUndefined();
    expect(mcpServiceHost("not a url")).toBeUndefined();
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
