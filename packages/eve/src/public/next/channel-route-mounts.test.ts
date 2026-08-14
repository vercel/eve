import { describe, expect, it } from "vitest";

import type { CompiledChannelEntry } from "#compiler/manifest.js";
import {
  createEveChannelRouteMounts,
  createVercelRequestPath,
  createVercelRouteSource,
} from "./channel-route-mounts.js";

function channel(urlPath: string, method: "GET" | "POST" = "POST"): CompiledChannelEntry {
  return {
    kind: "channel",
    logicalPath: "channels/test.ts",
    method,
    name: "test",
    sourceId: `test:${method}:${urlPath}`,
    sourceKind: "module",
    urlPath,
  };
}

describe("eve Next.js channel route mounts", () => {
  it("publishes each non-protocol channel path once", () => {
    expect(
      createEveChannelRouteMounts({
        channels: [
          channel("/mcp", "GET"),
          channel("/mcp"),
          channel("/.well-known/oauth-protected-resource/mcp", "GET"),
          channel("/eve/v1/session"),
        ],
        publicRoutePrefix: "",
      }),
    ).toEqual([
      {
        publicPath: "/.well-known/oauth-protected-resource/mcp",
        routePath: "/.well-known/oauth-protected-resource/mcp",
      },
      { publicPath: "/mcp", routePath: "/mcp" },
    ]);
  });

  it("prefixes named-agent routes while preserving the service request path", () => {
    expect(
      createEveChannelRouteMounts({
        channels: [channel("/mcp")],
        publicRoutePrefix: "/eve/agents/support",
      }),
    ).toEqual([
      {
        publicPath: "/eve/agents/support/mcp",
        routePath: "/mcp",
      },
    ]);
  });

  it("converts channel parameters to Vercel named captures", () => {
    expect(createVercelRouteSource("/api/stream/:sessionId")).toBe(
      "^/api/stream/(?<sessionId>[^/]+)$",
    );
    expect(createVercelRequestPath("/api/stream/:sessionId")).toBe("/api/stream/$sessionId");
  });
});
