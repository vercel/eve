import { describe, expect, it } from "vitest";

import { buildConnectionConfigure, buildConnectionSetup } from "./connection-setup";
import { getIntegration } from "./data";

describe("Kernel connection setup", () => {
  it("uses the named Connect connector created for Kernel's MCP service", () => {
    const integration = getIntegration("kernel")!;
    const setup = buildConnectionSetup(integration);

    expect(setup.variants["mcp:user"]).toContain('auth: connect("mcp.onkernel.com/kernel")');
    expect(buildConnectionConfigure(integration)).toContain(
      "vercel connect create mcp.onkernel.com --name kernel",
    );
  });
});
