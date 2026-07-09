import { describe, expect, it } from "vitest";

import {
  INTEGRATIONS,
  channelEntries,
  connectionIntegrationRecords,
  connectionEntries,
  connectionProtocols,
  connectionSurfacesByProtocol,
  getIntegrationEntry,
} from "./index.js";

describe("integration catalog", () => {
  it("has unique slugs", () => {
    const slugs = INTEGRATIONS.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("partitions cleanly into channels and connections", () => {
    expect(channelEntries().length + connectionEntries().length).toBe(INTEGRATIONS.length);
  });

  it("gives every connection a transport and description", () => {
    for (const entry of connectionEntries()) {
      expect(entry.connection).toBeDefined();
      expect(entry.connection?.description).toBeTruthy();
      expect(connectionProtocols(entry.connection!).length).toBeGreaterThan(0);
    }
  });

  it("keeps channels free of connection identity", () => {
    for (const entry of channelEntries()) {
      expect(entry.connection).toBeUndefined();
    }
  });

  it("looks up entries by slug", () => {
    expect(getIntegrationEntry("linear")?.name).toBe("Linear");
    expect(getIntegrationEntry("nope")).toBeUndefined();
  });

  it("derives protocols from declared transports", () => {
    expect(connectionProtocols(getIntegrationEntry("notion")!.connection!)).toEqual([
      "mcp",
      "openapi",
    ]);
    expect(connectionProtocols(getIntegrationEntry("linear")!.connection!)).toEqual(["mcp"]);
  });

  it("uses Linear's streamable HTTP MCP endpoint", () => {
    expect(getIntegrationEntry("linear")!.connection!.mcp!.url).toBe("https://mcp.linear.app/mcp");
  });

  it("builds MCP/OpenAPI-only connection integration records", () => {
    const records = connectionIntegrationRecords();
    expect(records.map((record) => record.slug)).toEqual(
      connectionEntries()
        .filter((entry) => entry.surfaces.gallery)
        .map((entry) => entry.slug),
    );
    for (const record of records) {
      const surfaceSlugs = record.surfaces.map((surface) => surface.slug);
      expect(new Set(surfaceSlugs).size).toBe(surfaceSlugs.length);
      expect(record.basis.via).toBe("curated");
      for (const surface of record.surfaces) {
        expect(["mcp", "openapi"]).toContain(surface.type);
        expect(surface.basis.via).toBe("curated");
        if (surface.type === "mcp") {
          expect(surface.url).toMatch(/^https:\/\//);
        } else {
          expect(surface.spec).toMatch(/^https:\/\//);
        }
      }
    }
  });

  it("keeps surface credential references valid", () => {
    for (const record of connectionIntegrationRecords()) {
      for (const surface of record.surfaces) {
        if (surface.auth.status !== "required") continue;
        for (const entry of surface.auth.entries) {
          for (const credentialUse of entry.use) {
            expect(record.credentials?.[credentialUse.id]).toBeDefined();
          }
        }
      }
    }
  });

  it("indexes surfaces by protocol", () => {
    expect(
      connectionSurfacesByProtocol("openapi").map(({ integration }) => integration.slug),
    ).toEqual([
      "notion",
      "stripe",
      "sentry",
      "github-rest",
      "asana",
      "jira",
      "slack-web-api",
      "twilio-api",
    ]);
    expect(connectionSurfacesByProtocol("mcp").map(({ integration }) => integration.slug)).toEqual([
      "linear",
      "notion",
      "datadog",
      "honeycomb",
      "stripe",
      "sentry",
    ]);
  });
});
