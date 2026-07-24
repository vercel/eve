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

describe("Kernel extension setup", () => {
  it("uses Kernel's eve extension with Vercel Connect", () => {
    const integration = getIntegration("kernel")!;

    expect(integration.type).toBe("extension");
    expect(integration.install).toContain("pnpm add @onkernel/eve-extension");
    expect(integration.quickStart).toContain(
      'kernel({ connect: "mcp.onkernel.com/eve-extension" })',
    );
    expect(integration.configure).toContain("KERNEL_API_KEY");
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
