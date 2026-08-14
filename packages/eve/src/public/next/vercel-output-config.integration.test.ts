import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureEveVercelOutputConfig } from "./vercel-output-config.js";

describe("eve Next.js Vercel output config", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("publishes prefixed channel routes to the owning eve service", async () => {
    const nextRoot = await mkdtemp(join(tmpdir(), "eve-next-channel-routes-"));
    temporaryRoots.push(nextRoot);
    vi.stubEnv("VERCEL", "1");

    await ensureEveVercelOutputConfig({
      agents: [
        {
          appRoot: join(nextRoot, "agents", "support"),
          buildCommand: "eve build",
          channelRouteMounts: [
            {
              publicPath: "/eve/agents/support/mcp",
              routePath: "/mcp",
            },
            {
              publicPath: "/eve/agents/support/.well-known/oauth-protected-resource/mcp",
              routePath: "/.well-known/oauth-protected-resource/mcp",
            },
          ],
          name: "support",
          publicRoutePrefix: "/eve/agents/support",
          servicePrefix: "/_eve_internal/eve/support",
        },
      ],
      nextRoot,
    });

    const config = JSON.parse(
      await readFile(join(nextRoot, ".vercel", "output", "config.json"), "utf8"),
    ) as {
      routes: unknown[];
    };

    expect(config.routes).toEqual(
      expect.arrayContaining([
        {
          src: "^/eve/agents/support/mcp$",
          transforms: [{ args: "/mcp", op: "set", type: "request.path" }],
        },
        {
          destination: { service: "eve-support", type: "service" },
          src: "^/eve/agents/support/mcp$",
        },
        {
          src: "^/eve/agents/support/\\.well-known/oauth-protected-resource/mcp$",
          transforms: [
            {
              args: "/.well-known/oauth-protected-resource/mcp",
              op: "set",
              type: "request.path",
            },
          ],
        },
      ]),
    );
  });
});
