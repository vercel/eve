import { describe, expect, it } from "vitest";

import { connectConnectorName } from "./connect-connector-name.js";

describe("connectConnectorName", () => {
  it("qualifies a connector name with its project and Connect service type", () => {
    expect(connectConnectorName("my-agent", "slack")).toBe("my-agent-slack");
    expect(connectConnectorName("my-agent", "mcp.linear.app", "linear")).toBe(
      "my-agent-linear-mcp",
    );
  });
});
