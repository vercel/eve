import { describe, expect, it } from "vitest";

import { dynamicEvaluate, isDynamicSentinel } from "#dynamic/definition.js";
import { defineDynamic } from "#public/definitions/connections/dynamic.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";

describe("defineDynamic connections", () => {
  it("creates the shared dynamic sentinel", () => {
    const handler = () =>
      defineMcpClientConnection({
        description: "Current account.",
        url: "https://mcp.example.com/current",
      });

    const dynamic = defineDynamic(handler);
    expect(isDynamicSentinel(dynamic)).toBe(true);
    expect(dynamicEvaluate(dynamic)).toBe(handler);
  });
});
