import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createExternalDependencyOutputCheckPlugin } from "#internal/nitro/host/external-dependency-output-check-plugin.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createDirectory = useTemporaryDirectories();

const APP_ROOT = join("/app");

// A `pg` install whose exports include `./lib/client` only when `withClient`.
async function writePackage(packageDir: string, input: { readonly withClient: boolean }) {
  await mkdir(join(packageDir, "lib"), { recursive: true });
  await writeFile(join(packageDir, "index.js"), "export default {};\n");
  await writeFile(join(packageDir, "lib", "client.js"), "export default {};\n");
  const exports = input.withClient
    ? { ".": "./index.js", "./lib/client": "./lib/client.js" }
    : { ".": "./index.js" };
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ exports, name: "pg" }));
}

async function checkOutput(input: {
  readonly installAt: "server" | "above" | "linked" | "nowhere";
  readonly withClient?: boolean;
}) {
  const root = await createDirectory("eve-external-output-check-");
  const serverDir = join(root, "server");
  await mkdir(join(serverDir, "_chunks"), { recursive: true });
  const withClient = input.withClient ?? true;
  if (input.installAt === "server") {
    await writePackage(join(serverDir, "node_modules", "pg"), { withClient });
  }
  if (input.installAt === "above") {
    await writePackage(join(root, "node_modules", "pg"), { withClient });
  }
  if (input.installAt === "linked") {
    // pnpm's layout: the output's node_modules entry links to a store
    // outside it (on Windows, possibly another drive).
    await writePackage(join(root, "store", "pg"), { withClient });
    await mkdir(join(serverDir, "node_modules"), { recursive: true });
    await symlink(join(root, "store", "pg"), join(serverDir, "node_modules", "pg"), "junction");
  }

  const plugin = createExternalDependencyOutputCheckPlugin({
    appRoot: APP_ROOT,
    externalDependencies: ["pg"],
  });
  await plugin?.writeBundle(
    { dir: serverDir },
    {
      "_chunks/db.mjs": {
        code: "",
        dynamicImports: [],
        fileName: "_chunks/db.mjs",
        imports: ["pg/lib/client"],
        type: "chunk",
      },
      "index.mjs": {
        code: "",
        dynamicImports: ["pg"],
        fileName: "index.mjs",
        imports: ["_chunks/db.mjs", "zod"],
        type: "chunk",
      },
    },
  );
}

// Installs `pg` in the output from `files` (path -> contents, `package.json`
// included) and checks a chunk that imports bare `pg`. Returns the output's
// remaining file list, so tests can assert the probes are cleaned up.
async function checkInstalledPackage(files: Readonly<Record<string, string>>) {
  const serverDir = join(await createDirectory("eve-external-output-check-"), "server");
  const packageDir = join(serverDir, "node_modules", "pg");
  await mkdir(packageDir, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    await writeFile(join(packageDir, path), contents);
  }
  await createExternalDependencyOutputCheckPlugin({
    appRoot: APP_ROOT,
    externalDependencies: ["pg"],
  })?.writeBundle(
    { dir: serverDir },
    {
      "index.mjs": {
        code: "",
        dynamicImports: [],
        fileName: "index.mjs",
        imports: ["pg"],
        type: "chunk",
      },
    },
  );
  return readdir(serverDir, { recursive: true });
}

const missing = (specifier: string, chunk: string) =>
  `"${specifier}" is listed in build.externalDependencies and imported by the hosted bundle (${chunk}), but the build output cannot resolve it. Add "pg" to the dependencies in ${join(APP_ROOT, "package.json")}.`;

describe("external dependency output check", () => {
  it("accepts a configured external the output resolves", async () => {
    await expect(checkOutput({ installAt: "server" })).resolves.toBeUndefined();
  });

  it("rejects a configured external the output does not contain", async () => {
    await expect(checkOutput({ installAt: "nowhere" })).rejects.toThrow(
      missing("pg/lib/client", "_chunks/db.mjs"),
    );
  });

  it("rejects a package that only resolves from above the output", async () => {
    await expect(checkOutput({ installAt: "above" })).rejects.toThrow(
      missing("pg/lib/client", "_chunks/db.mjs"),
    );
  });

  it("rejects a package linked into the output from outside it", async () => {
    await expect(checkOutput({ installAt: "linked" })).rejects.toThrow(
      missing("pg/lib/client", "_chunks/db.mjs"),
    );
  });

  it("rejects an imported subpath the packaged version does not export", async () => {
    await expect(checkOutput({ installAt: "server", withClient: false })).rejects.toThrow(
      missing("pg/lib/client", "_chunks/db.mjs"),
    );
  });

  it("rejects a legacy main that only resolves by adding an extension Node does not try", async () => {
    await expect(
      checkInstalledPackage({
        "index.mjs": "export default {};\n",
        "package.json": JSON.stringify({ main: "./index", name: "pg" }),
      }),
    ).rejects.toThrow(missing("pg", "index.mjs"));
  });

  it("accepts a legacy main that names its file", async () => {
    await expect(
      checkInstalledPackage({
        "index.mjs": "export default {};\n",
        "package.json": JSON.stringify({ main: "./index.mjs", name: "pg" }),
      }),
    ).resolves.not.toContainEqual(expect.stringContaining(".eve-resolve-"));
  });

  it("rejects an exports target the output does not contain", async () => {
    await expect(
      checkInstalledPackage({
        "package.json": JSON.stringify({ exports: "./index.js", name: "pg" }),
      }),
    ).rejects.toThrow(missing("pg", "index.mjs"));
  });

  it("does nothing when no externals are configured", () => {
    expect(
      createExternalDependencyOutputCheckPlugin({ appRoot: APP_ROOT, externalDependencies: [] }),
    ).toBeNull();
  });
});
