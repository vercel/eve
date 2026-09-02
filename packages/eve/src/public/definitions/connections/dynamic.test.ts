import { describe, expect, it } from "vitest";

import { defineDynamic } from "#public/definitions/connections/dynamic.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";

describe("defineDynamic connections", () => {
  it("creates the shared dynamic sentinel", () => {
    const handler = () =>
      defineMcpClientConnection({
        description: "Current account.",
        url: "https://mcp.example.com/current",
      });

    expect(defineDynamic({ events: { "session.started": handler } })).toMatchObject({
      events: { "session.started": handler },
      kind: "eve:dynamic",
    });
  });
});
