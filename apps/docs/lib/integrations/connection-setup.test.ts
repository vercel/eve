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
    const userConfigure = setup.configureVariants["mcp:user"];
    const appConfigure = setup.configureVariants["mcp:app"];

    expect(userConfigure).toContain("vercel connect create vercel --name vercel");
    expect(userConfigure).toContain("Select None");
    expect(userConfigure).not.toContain("create api-key");
    expect(appConfigure).toContain("vercel connect create api-key --name vercel");
    expect(appConfigure).not.toContain("Select None");
    expect(appConfigure).toContain(
      "[Vercel token](https://vercel.com/kb/guide/how-do-i-use-a-vercel-api-access-token)",
    );
    expect(appConfigure).toContain("copy the returned connector UID into the App example");
    expect(appConfigure).toContain("token still belongs to the user who created it");

    const configure = buildConnectionConfigure(integration);
    expect(configure).toContain("### MCP · User");
    expect(configure).toContain("### MCP · App");
    expect(configure).not.toContain("vercel connect attach");
  });
});
