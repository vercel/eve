import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveInstalledEveVersion } from "./resolve-eve-version.js";

describe("resolveInstalledEveVersion", () => {
  it("reads the version of the eve an application root resolves", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-version-"));
    const eveRoot = join(workspaceRoot, "node_modules", "eve");
    await mkdir(eveRoot, { recursive: true });
    await writeFile(
      join(eveRoot, "package.json"),
      JSON.stringify({ name: "eve", version: "0.0.7" }),
    );

    const appRoot = join(workspaceRoot, "agents", "support");
    await mkdir(appRoot, { recursive: true });

    expect(resolveInstalledEveVersion(appRoot)).toBe("0.0.7");
  });
});
