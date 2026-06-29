import { describe, expect, it } from "vitest";

import {
  INTEGRATIONS,
  channelEntries,
  connectionEntries,
  connectionProtocols,
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
});
