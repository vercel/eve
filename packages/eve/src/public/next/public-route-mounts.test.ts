import { describe, expect, it } from "vitest";

import {
  createEvePublicRouteMounts,
  createVercelRequestPath,
  createVercelRouteSource,
} from "./public-route-mounts.js";

describe("eve Next.js public route mounts", () => {
  it("normalizes, deduplicates, and sorts registered paths", () => {
    expect(
      createEvePublicRouteMounts({
        publicRoutePrefix: "",
        publicRoutes: ["/mcp", "/.well-known/ucp", "/mcp"],
      }),
    ).toEqual([
      {
        publicPath: "/.well-known/ucp",
        routePath: "/.well-known/ucp",
      },
      { publicPath: "/mcp", routePath: "/mcp" },
    ]);
  });

  it("prefixes named-agent paths while preserving the service request path", () => {
    expect(
      createEvePublicRouteMounts({
        publicRoutePrefix: "/eve/agents/support",
        publicRoutes: ["/.well-known/ucp"],
      }),
    ).toEqual([
      {
        publicPath: "/eve/agents/support/.well-known/ucp",
        routePath: "/.well-known/ucp",
      },
    ]);
  });

  it("converts route parameters to Vercel named captures", () => {
    expect(createVercelRouteSource("/api/stream/:sessionId")).toBe(
      "^/api/stream/(?<sessionId>[^/]+)$",
    );
    expect(createVercelRequestPath("/api/stream/:sessionId")).toBe("/api/stream/$sessionId");
  });

  it("rejects paths the host cannot mount safely", () => {
    expect(() =>
      createEvePublicRouteMounts({ publicRoutePrefix: "", publicRoutes: ["relative"] }),
    ).toThrow('must start with "/"');
    expect(() =>
      createEvePublicRouteMounts({ publicRoutePrefix: "", publicRoutes: ["/eve/v1/info"] }),
    ).toThrow("already covered by the eve protocol mount");
    expect(() =>
      createEvePublicRouteMounts({ publicRoutePrefix: "", publicRoutes: ["/api/:bad-name"] }),
    ).toThrow("unsupported segment");
    expect(() =>
      createEvePublicRouteMounts({ publicRoutePrefix: "", publicRoutes: ["/api/:id/:id"] }),
    ).toThrow("repeats parameter");
  });
});
