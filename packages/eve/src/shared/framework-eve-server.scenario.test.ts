import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import { waitForCondition, withinDeadline } from "../../test/scenarios/dev-server-harness.js";
import { startEveProductionServer } from "./framework-eve-server.js";

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
  it("starts a quiet listening backend without any authored health route", async () => {
    const { root, config } = await fixture(`
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync("pid", String(process.pid));
await new Promise(resolve => setTimeout(resolve, 100));
createServer((_req, res) => { res.statusCode = 404; res.end("no channel"); }).listen(Number(process.env.PORT), process.env.HOST);
`);
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
      expect(handle.process?.signalCode).toBe("SIGTERM");
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
