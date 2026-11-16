import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { waitForCondition, withinDeadline } from "#internal/testing/dev-server-harness.js";
import { startEveProductionServer } from "./framework-eve-server.js";
import { withEve } from "#public/next/index.js";

const require = createRequire(import.meta.url);
const srvxEntry = pathToFileURL(createRequire(require.resolve("nitro")).resolve("srvx/node")).href;

async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "eve-framework-listener-"));
  await mkdir(join(root, ".output/server"), { recursive: true });
  await writeFile(join(root, ".output/server/index.mjs"), source);
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return {
    root,
    config: {
      appRoot: root,
      host: { label: "Next.js", slug: "next" },
      origin: `http://127.0.0.1:${address.port}`,
      portRetryHint: "choose another port",
    },
  };
}

describe("framework production process ownership", () => {
  it("starts srvx without an authored health route even when the parent sets TEST and CI", async () => {
    const { root, config } = await fixture(`
import { serve } from ${JSON.stringify(srvxEntry)};
import { writeFileSync } from "node:fs";
writeFileSync("pid", String(process.pid));
await new Promise(resolve => setTimeout(resolve, 100));
serve({ fetch: () => new Response("no channel", { status: 404 }) });
`);
    for (const key of ["TEST", "CI", "SERVER_SHUTDOWN_TIMEOUT", "NITRO_UNIX_SOCKET"]) {
      vi.stubEnv(key, "inherited");
    }
    const controller = new AbortController();
    const startup = startEveProductionServer({ ...config, signal: controller.signal });
    try {
      const handle = await withinDeadline(
        startup,
        "Listener readiness must not depend on an authored health route.",
        5_000,
      );
      try {
        const response = await fetch(`${handle.origin}/eve/v1/health`);
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("no channel");
      } finally {
        await handle.close!();
      }
      expect(handle.process?.exitCode).toBe(0);
    } finally {
      controller.abort();
      const pid = Number(await readFile(join(root, "pid"), "utf8").catch(() => "0"));
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already reaped. */
        }
      }
      await startup.catch(() => undefined);
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects Next's config before installing rewrites when another listener wins the bind race", async () => {
    const { root, config } = await fixture(`
import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
writeFileSync("pid", String(process.pid));
// The parent binds a competing listener after this child has been spawned.
while (!existsSync("bind")) await new Promise(resolve => setTimeout(resolve, 10));
setInterval(() => {}, 1000); // Like Nitro, remain alive after a failed bind.
const server = createServer();
server.on("error", error => {
  console.error("[srvx] Failed to start server:", error);
  process.exitCode = 1;
});
server.listen(Number(process.env.PORT), process.env.HOST, () => {
  console.log("➜ Listening on: http://" + process.env.HOST + ":" + process.env.PORT + "/");
});
`);
    const originalCwd = process.cwd();
    const attacker = createServer();
    let pid = 0;
    let startup: Promise<unknown> | undefined;
    try {
      process.chdir(root);
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VERCEL", "");
      vi.stubEnv("EVE_NEXT_PRODUCTION_ORIGIN", "");
      vi.stubEnv("EVE_NEXT_PRODUCTION_PORT", new URL(config.origin).port);
      startup = Promise.resolve(withEve({})("phase-production-server", { defaultConfig: {} }));
      const rejected = expect(startup).rejects.toThrow("already in use");
      void rejected.catch(() => undefined);
      await waitForCondition(
        async () => {
          pid = Number(await readFile(join(root, "pid"), "utf8").catch(() => "0"));
          return pid > 0;
        },
        () => "Child did not start after preflight",
        5_000,
      );
      await new Promise<void>((resolve) =>
        attacker.listen(Number(new URL(config.origin).port), "127.0.0.1", resolve),
      );
      // Allow the old TCP+liveness readiness check to falsely accept the attacker.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(join(root, "bind"), "");
      await withinDeadline(
        rejected,
        "Next must not return a config with attacker-directed rewrites",
        5_000,
      );
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already reaped. */
        }
      }
      await startup?.catch(() => undefined);
      await new Promise<void>((resolve) => attacker.close(() => resolve()));
      process.chdir(originalCwd);
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels and reaps a child while startup is still pending", async () => {
    const { root, config } = await fixture(`
import { writeFileSync } from "node:fs";
writeFileSync("pid", String(process.pid));
setInterval(() => {}, 1000);
`);
    const controller = new AbortController();
    const before = {
      exit: process.listenerCount("exit"),
      beforeExit: process.listenerCount("beforeExit"),
    };
    const startup = startEveProductionServer({ ...config, signal: controller.signal });
    const rejected = expect(startup).rejects.toThrow("startup was cancelled");
    try {
      let pid = 0;
      await waitForCondition(
        async () => {
          pid = Number(await readFile(join(root, "pid"), "utf8").catch(() => "0"));
          return pid > 0;
        },
        () => "Child did not start",
        5_000,
      );
      controller.abort();
      await rejected;
      expect(() => process.kill(pid, 0)).toThrow();
      expect({
        exit: process.listenerCount("exit"),
        beforeExit: process.listenerCount("beforeExit"),
      }).toEqual(before);
    } finally {
      controller.abort();
      await startup.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
