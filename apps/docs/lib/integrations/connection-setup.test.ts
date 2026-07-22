import { describe, expect, it } from "vitest";

import {
  buildConnectionConfigure,
  buildConnectionInstall,
  buildConnectionSetup,
} from "./connection-setup";
import { getIntegration } from "./data";

describe("Browser Use connection setup", () => {
  it("generates server-side header authentication without Connect", () => {
    const integration = getIntegration("browser-use")!;
    const setup = buildConnectionSetup(integration);
    const quickStart = setup.variants["mcp:apiKey"];

    expect(quickStart).toContain('"x-browser-use-api-key": process.env.BROWSER_USE_API_KEY!');
    expect(quickStart).not.toContain("@vercel/connect");
    expect(buildConnectionInstall(integration)).toContain("npm install eve@latest");
    expect(buildConnectionInstall(integration)).not.toContain("@vercel/connect");
    expect(buildConnectionConfigure(integration)).toContain("BROWSER_USE_API_KEY=your_api_key");
  });

  it("keeps Connect setup for OAuth connections", () => {
    const integration = getIntegration("linear")!;
    const quickStart = buildConnectionSetup(integration).variants["mcp:user"];

    expect(quickStart).toContain("@vercel/connect/eve");
    expect(buildConnectionInstall(integration)).toContain("@vercel/connect");
  });
});

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

describe("Vercel MCP connection setup", () => {
  it("uses Vercel's MCP endpoint and Connect service", () => {
    const integration = getIntegration("vercel")!;
    const quickStart = buildConnectionSetup(integration).variants["mcp:user"];

    expect(quickStart).toContain('url: "https://mcp.vercel.com"');
    expect(quickStart).toContain('auth: connect("vercel")');
    const configure = buildConnectionConfigure(integration);
    expect(configure).toContain("vercel connect create vercel");
    expect(configure).not.toContain("vercel connect attach");
    expect(configure.indexOf("vercel link")).toBeLessThan(
      configure.indexOf("vercel connect create vercel"),
    );
    expect(configure).toContain("select None");
  });
});
