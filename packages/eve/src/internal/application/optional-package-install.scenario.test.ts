import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();
const run = promisify(execFile);

describe("optional package installation locking", () => {
  it("installs different packages from concurrent processes into one workspace", async () => {
    const root = await createScratchDirectory("eve-optional-install-race-");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "workspace", private: true }),
    );
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - apps/*\nminimumReleaseAge: 0\n",
    );
    for (const name of ["one", "two"]) {
      await mkdir(join(root, "apps", name), { recursive: true });
      await writeFile(
        join(root, "apps", name, "package.json"),
        JSON.stringify({ name, private: true }),
      );
      await mkdir(join(root, "deps", name), { recursive: true });
      await writeFile(
        join(root, "deps", name, "package.json"),
        JSON.stringify({ name: `engine-${name}`, version: "1.0.0", main: "index.js" }),
      );
      await writeFile(
        join(root, "deps", name, "index.js"),
        `module.exports = ${JSON.stringify(name)};`,
      );
    }
    const installer = new URL(
      "../../../dist/src/internal/application/optional-package-install.js",
      import.meta.url,
    ).href;
    const outputs = await Promise.all(
      ["one", "two"].map((name) =>
        run(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
      import { createRequire } from 'node:module';
      import { loadOptionalEnginePackage } from ${JSON.stringify(installer)};
      const require = createRequire(process.cwd() + '/package.json');
      const result = await loadOptionalEnginePackage({
        appRoot: process.cwd(), autoInstall: true,
        packageName: ${JSON.stringify(`engine-${name}`)},
        installPackageName: ${JSON.stringify(`engine-${name}@file:../../deps/${name}`)},
        missingMessage: 'missing engine',
        importModule: async () => { throw new Error('missing'); },
        importInstalledModule: async () => require(${JSON.stringify(`engine-${name}`)}),
      });
      console.log('loaded:' + result);
    `,
          ],
          { cwd: join(root, "apps", name), env: { ...process.env, EVE_DEV: "1" }, timeout: 60_000 },
        ),
      ),
    );
    expect(outputs[0]!.stdout).toContain("loaded:one");
    expect(outputs[1]!.stdout).toContain("loaded:two");
    const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
    expect(lockfile).toContain("engine-one");
    expect(lockfile).toContain("engine-two");
  });
});
