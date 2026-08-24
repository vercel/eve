import { describe, expect, it } from "vitest";

import { normalizeChannelDefinition } from "#internal/authored-definition/channel.js";

const FAILURE_MESSAGE = "Expected the channel export to match the public eve shape.";
const handler = async () => new Response("ok");

function channel(route: unknown): unknown {
  return {
    __kind: "eve:channel",
    adapter: { kind: "test" },
    routes: [route],
  };
}

describe("normalizeChannelDefinition", () => {
  it("accepts an HTTP route with omitted transport and a lowercase supported method", () => {
    const definition = channel({ handler, method: "get", path: "/status" });

    expect(normalizeChannelDefinition(definition, FAILURE_MESSAGE)).toBe(definition);
  });

  it("rejects an unsupported HTTP method", () => {
    expect(() =>
      normalizeChannelDefinition(
        channel({ handler, method: "TRACE", path: "/status", transport: "http" }),
        FAILURE_MESSAGE,
      ),
    ).toThrow("Route at index 0 must declare a supported HTTP method.");
  });

  it.each([
    {
      expected: 'uses `transport: "websocket"` and must declare method `"WEBSOCKET"`',
      route: { handler, method: "GET", path: "/socket", transport: "websocket" },
    },
    {
      expected: 'HTTP transport cannot declare method `"WEBSOCKET"`',
      route: { handler, method: "WEBSOCKET", path: "/socket", transport: "http" },
    },
  ])("rejects incoherent route transport and method: $expected", ({ expected, route }) => {
    expect(() => normalizeChannelDefinition(channel(route), FAILURE_MESSAGE)).toThrow(expected);
  });

  it("rejects a non-string route path", () => {
    expect(() =>
      normalizeChannelDefinition(channel({ handler, method: "GET", path: 42 }), FAILURE_MESSAGE),
    ).toThrow("Route at index 0 must declare a string `path`.");
  });

  it("rejects a non-function route handler", () => {
    expect(() =>
      normalizeChannelDefinition(
        channel({ handler: "not-a-function", method: "GET", path: "/status" }),
        FAILURE_MESSAGE,
      ),
    ).toThrow("Route at index 0 must declare a function `handler`.");
  });
});
