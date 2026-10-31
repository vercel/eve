import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { buildApplication } from "#internal/nitro/host.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

interface HostedServer {
  fetch(
    request: Request,
    context: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response>;
}

describe("channel routes", () => {
  // vercel/eve#5742: the bundler typed each route's handler module by the
  // extension its path ends in.
  it("builds and serves paths that end in a file extension", async () => {
    const paths = ["/.well-known/agent-card.json", "/robots.txt", "/legacy.cjs", "/theme.css"];
    const { appRoot } = await createAppRoot("eve-channel-route-extension-", {
      files: {
        "agent/agent.ts": [
          'import { defineAgent } from "eve";',
          'export default defineAgent({ model: "openai/gpt-5.4-mini" });',
        ].join("\n"),
        "agent/instructions.md": "Reply briefly.\n",
        "agent/channels/files.ts": [
          'import { defineChannel, GET } from "eve/channels";',
          "export default defineChannel({",
          "  cors: true,",
          `  routes: ${JSON.stringify(paths)}.map((path) => GET(path, () => new Response(path))),`,
          "});",
        ].join("\n"),
      },
    });

    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    const outputDir = await buildApplication(appRoot, { skipSandboxPrewarm: true });
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_channel_route_extension");
    const server = (
      (await import(
        pathToFileURL(join(outputDir, "functions", "__server.func", "index.mjs")).href
      )) as { default: HostedServer }
    ).default;
    const send = (path: string, init?: RequestInit) =>
      server.fetch(new Request(`https://example.com${path}`, init), { waitUntil() {} });

    for (const path of paths) {
      const response = await send(path);
      expect(response.status, path).toBe(200);
      expect(await response.text()).toBe(path);
    }
    const preflight = await send(paths[0]!, {
      headers: { "access-control-request-method": "GET", origin: "https://client.example.com" },
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
  }, 120_000);
});
