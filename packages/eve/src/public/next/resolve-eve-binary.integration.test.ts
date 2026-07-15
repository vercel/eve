import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveEveBinaryPath } from "./resolve-eve-binary.js";

// Writes a minimal installed eve package under `root/node_modules/eve` and
// returns the realpath the resolver is expected to produce (createRequire
// canonicalizes symlinks, and macOS routes tmpdir through one).
async function writeEvePackage(root: string): Promise<string> {
  const eveRoot = join(root, "node_modules", "eve");
  await mkdir(join(eveRoot, "bin"), { recursive: true });
  await writeFile(join(eveRoot, "package.json"), JSON.stringify({ name: "eve", version: "0.0.0" }));
  await writeFile(join(eveRoot, "bin", "eve.js"), "#!/usr/bin/env node\n");
  return join(await realpath(eveRoot), "bin", "eve.js");
}

describe("resolveEveBinaryPath", () => {
  it("resolves eve hoisted to the workspace root (npm workspaces)", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-resolve-"));
    const expected = await writeEvePackage(workspaceRoot);

    // The app has no eve under its own node_modules — npm hoisted it up.
    const appRoot = join(workspaceRoot, "apps", "web");
    await mkdir(appRoot, { recursive: true });
    await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "web" }));

    expect(resolveEveBinaryPath(appRoot)).toBe(expected);
  });

  it("resolves eve from an app-local install (pnpm layout)", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-resolve-"));
    const expected = await writeEvePackage(appRoot);
    await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "web" }));

    expect(resolveEveBinaryPath(appRoot)).toBe(expected);
  });
});
