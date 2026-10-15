import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveNodeExecutable } from "./node-executable.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function createExecutable(path: string): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, 0o755);
  return path;
}

/** Mirrors what `bun --bun` does: a `bun-node-*` PATH entry whose `node` links to Bun. */
async function createBunLayout(): Promise<{ bun: string; root: string; shimDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), "eve-node-executable-"));
  tempRoots.push(root);
  const bun = await createExecutable(join(root, "bun", "bin", "bun"));
  const shimDirectory = join(root, "bun-node-1234");
  await mkdir(shimDirectory);
  await symlink(bun, join(shimDirectory, "node"));
  return { bun, root, shimDirectory };
}

describe.skipIf(process.platform === "win32")("resolveNodeExecutable", () => {
  it("uses the current executable outside Bun", () => {
    expect(
      resolveNodeExecutable({
        execPath: "/usr/local/bin/node",
        isBun: false,
        path: undefined,
        platform: "linux",
      }),
    ).toBe("/usr/local/bin/node");
  });

  it("skips Bun's node shim and finds a real Node.js on PATH", async () => {
    const { bun, root, shimDirectory } = await createBunLayout();
    const node = await createExecutable(join(root, "node", "bin", "node"));
    const bunLinkDirectory = join(root, "links");
    await mkdir(bunLinkDirectory);
    await symlink(bun, join(bunLinkDirectory, "node"));

    expect(
      resolveNodeExecutable({
        execPath: bun,
        isBun: true,
        path: [shimDirectory, bunLinkDirectory, join(root, "node", "bin")].join(delimiter),
        platform: "linux",
      }),
    ).toBe(node);
  });

  it("explains how to recover when only Bun is available", async () => {
    const { bun, shimDirectory } = await createBunLayout();

    expect(() =>
      resolveNodeExecutable({
        execPath: bun,
        isBun: true,
        path: shimDirectory,
        platform: "linux",
      }),
    ).toThrow("start your framework dev server without `bun --bun`");
  });
});
