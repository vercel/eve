import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { packPackage } from "./pack.mjs";

const execFile = promisify(execFileCallback);
let testRoot;

afterEach(async () => {
  if (testRoot !== undefined) await rm(testRoot, { force: true, recursive: true });
});

describe("packPackage", () => {
  test("preserves pnpm manifest transformations and stamps build metadata", async () => {
    testRoot = await mkdtemp(join(tmpdir(), "eve-package-artifacts-test-"));
    const packageRoot = join(testRoot, "packages", "test-package");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(testRoot, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\ncatalog:\n  example: "1.2.3"\n',
    );
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "eve-pack-test",
        version: "0.33.3",
        peerDependencies: { example: "catalog:" },
      }),
    );

    const version = "0.33.3+main.abc";
    const tarball = await packPackage(packageRoot, version);
    const tarballPath = join(testRoot, "package.tgz");
    await writeFile(tarballPath, tarball);

    const { stdout } = await execFile("tar", ["-xOf", tarballPath, "package/package.json"]);
    const packageJson = JSON.parse(stdout);
    expect(packageJson.version).toBe(version);
    expect(packageJson.peerDependencies.example).toBe("1.2.3");
  });
});
