import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("extension eve peer compatibility", () => {
  it.each(["0.24.6", "0.25.0-beta.1"])(
    "installs with eve %s under npm strict peer checks",
    async (eveVersion) => {
      const root = await mkdtemp(join(tmpdir(), "eve-extension-peer-"));
      roots.push(root);
      const eveRoot = join(root, "eve-package");
      const extensionRoot = join(root, "extension-package");
      const appRoot = join(root, "app");
      await Promise.all([mkdir(eveRoot), mkdir(extensionRoot), mkdir(appRoot)]);
      await Promise.all([
        writePackageJson(eveRoot, { name: "eve", version: eveVersion }),
        writePackageJson(extensionRoot, {
          name: "@acme/extension-peer-test",
          version: "1.0.0",
          peerDependencies: { eve: "*" },
        }),
        writePackageJson(appRoot, { name: "consumer", version: "1.0.0", private: true }),
      ]);

      await Promise.all([
        runNpm(["pack", "--pack-destination", root], eveRoot),
        runNpm(["pack", "--pack-destination", root], extensionRoot),
      ]);
      await runNpm(
        [
          "install",
          "--strict-peer-deps",
          "--ignore-scripts",
          "--no-package-lock",
          join(root, `eve-${eveVersion}.tgz`),
          join(root, "acme-extension-peer-test-1.0.0.tgz"),
        ],
        appRoot,
      );

      const installed = JSON.parse(
        await readFile(join(appRoot, "node_modules", "eve", "package.json"), "utf8"),
      ) as { version?: string };
      expect(installed.version).toBe(eveVersion);
    },
  );
});

async function writePackageJson(root: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, "package.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runNpm(arguments_: readonly string[], cwd: string): Promise<void> {
  await promisify(execFile)(process.platform === "win32" ? "npm.cmd" : "npm", [...arguments_], {
    cwd,
  });
}
