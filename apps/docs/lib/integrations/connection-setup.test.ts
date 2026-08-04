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
    expect(buildConnectionInstall(integration)).toContain("eve add connection/browser-use");
    expect(buildConnectionConfigure(integration)).toContain("BROWSER_USE_API_KEY=your_api_key");
  });

  it("keeps Connect setup for OAuth connections", () => {
    const integration = getIntegration("linear")!;
    const quickStart = buildConnectionSetup(integration).variants["mcp:user"];

    expect(quickStart).toContain("@vercel/connect/eve");
    expect(buildConnectionInstall(integration)).toContain("eve add connection/linear");
  });
});

describe("Kernel extension setup", () => {
  it("uses Kernel's eve extension with Vercel Connect", () => {
    const integration = getIntegration("kernel")!;

    expect(integration.type).toBe("extension");
    expect(integration.install).toContain("eve add extension/kernel");
    expect(integration.quickStart).toContain(
      'kernel({ connect: "mcp.onkernel.com/eve-extension" })',
    );
    expect(integration.configure).toContain("KERNEL_API_KEY");
  });
});

describe("Vercel MCP connection setup", () => {
  it("offers user OAuth and shared app credential setup", () => {
    const integration = getIntegration("vercel")!;
    const setup = buildConnectionSetup(integration);
    const userQuickStart = setup.variants["mcp:user"];
    const appQuickStart = setup.variants["mcp:app"];

    expect(setup.authModes).toEqual(["user", "app"]);
    expect(userQuickStart).toContain('url: "https://mcp.vercel.com"');
    expect(userQuickStart).toContain('auth: connect("vercel")');
    expect(appQuickStart).toContain(
      'auth: connect({ connector: "vercel/your-connector", principalType: "app" })',
    );
    expect(appQuickStart).toContain('"list_deployments"');
    expect(appQuickStart).toContain('"get_runtime_logs"');
    const configure = buildConnectionConfigure(integration);
    expect(configure).toContain("vercel connect create vercel");
    expect(configure).not.toContain("vercel connect attach");
    expect(configure.indexOf("vercel link")).toBeLessThan(
      configure.indexOf("vercel connect create vercel"),
    );
    expect(configure).toContain("select None");
    expect(configure).toContain("create an **API Key** connector");
    expect(configure).toContain("vercel connect create api-key --name vercel");
    expect(configure).toContain("Vercel tokens are always owned by a user");
    expect(configure).toContain("vercel/coffee-bridge");
  });
});
