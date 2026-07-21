import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { copyHostMiddlewareFunctions } from "#internal/nitro/host/copy-host-middleware.js";

const tempRoots: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eve-host-middleware-"));
  tempRoots.push(dir);
  return dir;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("copyHostMiddlewareFunctions", () => {
  it("skips silently when the host Build Output config is absent", async () => {
    const hostOutputDirectory = await createTempDir();
    const serviceOutputDirectory = await createTempDir();

    await expect(
      copyHostMiddlewareFunctions({ hostOutputDirectory, serviceOutputDirectory }),
    ).resolves.toBeUndefined();
  });

  it("copies a host middleware function referenced by a route into the service output", async () => {
    const hostOutputDirectory = await createTempDir();
    const serviceOutputDirectory = await createTempDir();
    const middlewareDir = join(hostOutputDirectory, "functions", "_middleware.func");
    await mkdir(middlewareDir, { recursive: true });
    await writeFile(join(middlewareDir, ".vc-config.json"), "{}\n");
    await writeFile(
      join(hostOutputDirectory, "config.json"),
      `${JSON.stringify({ version: 3, routes: [{ middlewarePath: "/_middleware" }] })}\n`,
    );

    await copyHostMiddlewareFunctions({ hostOutputDirectory, serviceOutputDirectory });

    expect(
      await pathExists(
        join(serviceOutputDirectory, "functions", "_middleware.func", ".vc-config.json"),
      ),
    ).toBe(true);
  });

  it("copies nothing when the host config declares no middleware", async () => {
    const hostOutputDirectory = await createTempDir();
    const serviceOutputDirectory = await createTempDir();
    await writeFile(
      join(hostOutputDirectory, "config.json"),
      `${JSON.stringify({ version: 3, routes: [{ handle: "filesystem" }] })}\n`,
    );

    await copyHostMiddlewareFunctions({ hostOutputDirectory, serviceOutputDirectory });

    expect(await pathExists(join(serviceOutputDirectory, "functions"))).toBe(false);
  });
});
