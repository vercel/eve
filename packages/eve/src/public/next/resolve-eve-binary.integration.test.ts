import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveEveBinaryPath } from "./resolve-eve-binary.js";

// Writes a minimal eve package at `dir` and returns its realpath'd bin path
// (createRequire canonicalizes symlinks, and macOS routes tmpdir through one).
async function writeEvePackage(dir: string): Promise<string> {
  await mkdir(join(dir, "bin"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "eve", version: "0.0.0" }));
  await writeFile(join(dir, "bin", "eve.js"), "#!/usr/bin/env node\n");
  return join(await realpath(dir), "bin", "eve.js");
}

describe("resolveEveBinaryPath", () => {
  it("resolves eve hoisted to the workspace root (npm workspaces)", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-resolve-"));
    const expected = await writeEvePackage(join(workspaceRoot, "node_modules", "eve"));

    // The app has no eve under its own node_modules; npm hoisted it up.
    const appRoot = join(workspaceRoot, "apps", "web");
    await mkdir(appRoot, { recursive: true });
    await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "web" }));

    // realpath both sides so Windows short (8.3) paths compare equal.
    expect(await realpath(resolveEveBinaryPath(appRoot))).toBe(expected);
  });

  it("resolves eve through pnpm's virtual-store symlink", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-resolve-"));
    await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "web" }));

    // pnpm installs the real package under .pnpm and symlinks node_modules/eve
    // to it; the resolver must follow the link to the store.
    const storeRoot = join(appRoot, "node_modules", ".pnpm", "eve@0.0.0", "node_modules", "eve");
    const expected = await writeEvePackage(storeRoot);
    await symlink(storeRoot, join(appRoot, "node_modules", "eve"), "junction");

    expect(await realpath(resolveEveBinaryPath(appRoot))).toBe(expected);
  });
});
