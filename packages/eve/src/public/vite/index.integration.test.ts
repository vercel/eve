import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { ConfigEnv, ProxyOptions, UserConfig } from "vite";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { resolveSharedEveDevServer } from "#shared/framework-eve-server.js";

import { eveVite } from "./index.js";

vi.mock("#shared/framework-eve-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#shared/framework-eve-server.js")>()),
  resolveSharedEveDevServer: vi.fn(),
}));

const resolveSharedEveDevServerMock = vi.mocked(resolveSharedEveDevServer);
const createTemporaryDirectory = useTemporaryDirectories();

describe("eveVite", () => {
  it("mounts each workspace agent under /eve/<name>/v1 and strips the name for its server", async () => {
    const root = await createTemporaryDirectory("eve-vite-");
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { eve: "*" } }));
    await Promise.all([
      mkdir(join(root, "agents", "support", "agent"), { recursive: true }),
      mkdir(join(root, "agents", "research", "agent"), { recursive: true }),
    ]);
    // Members resolve in name order: research, then support.
    resolveSharedEveDevServerMock
      .mockResolvedValueOnce({ origin: "http://127.0.0.1:4002" })
      .mockResolvedValueOnce({ origin: "http://127.0.0.1:4001" });
    const config = eveVite().config as {
      handler: (config: UserConfig, env: ConfigEnv) => Promise<UserConfig>;
    };

    const result = await config.handler({ root }, { command: "serve", mode: "development" });

    expect(resolveSharedEveDevServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appRoot: join(root, "agents", "support"),
        workspaceAgentName: "support",
      }),
    );
    const proxy = result.server?.proxy as Record<string, ProxyOptions>;
    expect(Object.keys(proxy).sort()).toEqual(["/eve/research/v1", "/eve/support/v1"]);
    expect(proxy["/eve/support/v1"]?.target).toBe("http://127.0.0.1:4001");
    expect(proxy["/eve/support/v1"]?.rewrite?.("/eve/support/v1/sessions?x=1")).toBe(
      "/eve/v1/sessions?x=1",
    );
  });
});
