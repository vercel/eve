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
