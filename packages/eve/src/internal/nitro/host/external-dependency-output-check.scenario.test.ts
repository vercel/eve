import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RolldownOutputChunk } from "#internal/bundler/nitro-rolldown.js";
import { checkExternalDependencyOutput } from "#internal/nitro/host/external-dependency-output-check.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();
const APP_ROOT = "/workspace/apps/agent";
const CHUNK = "server/chunks/tool.mjs";

function chunk(imports: { readonly static?: string[]; readonly dynamic?: string[] }) {
  const output: RolldownOutputChunk = {
    code: "",
    dynamicImports: imports.dynamic ?? [],
    fileName: CHUNK,
    imports: imports.static ?? [],
    isEntry: false,
    name: "tool",
    type: "chunk",
  };
  return { [CHUNK]: output };
}

/** An output directory whose chunk directory exists, as after Nitro writes it. */
async function createOutput(): Promise<string> {
  const outputDir = await realpath(await createScratchDirectory("eve-external-output-check-"));
  await mkdir(join(outputDir, "server", "chunks"), { recursive: true });
  return outputDir;
}

async function writePackage(
  root: string,
  input: { readonly exports: unknown; readonly files: readonly string[] },
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ exports: input.exports, name: "ext", type: "module", version: "1.0.0" }),
  );
  for (const file of input.files) {
    await writeFile(join(root, file), "export const value = 1;\n");
  }
}

async function check(
  outputDir: string,
  imports: { readonly static?: string[]; readonly dynamic?: string[] },
): Promise<void> {
  await checkExternalDependencyOutput({
    appRoot: APP_ROOT,
    bundle: chunk(imports),
    externalDependencies: ["ext"],
    outputDir,
  });
}

const missingExternal = (specifier: string) =>
  `"${specifier}" is listed in build.externalDependencies and imported by the hosted bundle (${CHUNK}), but the build output cannot resolve it. Add "ext" to the dependencies in ${join(APP_ROOT, "package.json")}.`;

describe("checkExternalDependencyOutput", () => {
  it("accepts an external that resolves to a file inside the output", async () => {
    const outputDir = await createOutput();
    await writePackage(join(outputDir, "server", "node_modules", "ext"), {
      exports: "./index.js",
      files: ["index.js"],
    });

    await expect(check(outputDir, { static: ["ext"] })).resolves.toBeUndefined();
  });

  it("rejects a missing external and names the app manifest to fix", async () => {
    const outputDir = await createOutput();

    await expect(check(outputDir, { static: ["ext"] })).rejects.toThrow(missingExternal("ext"));
  });

  it("checks literal dynamic imports like static ones", async () => {
    const outputDir = await createOutput();

    await expect(check(outputDir, { dynamic: ["ext"] })).rejects.toThrow(missingExternal("ext"));
  });

  it("rejects a subpath the packaged version does not export", async () => {
    const outputDir = await createOutput();
    await writePackage(join(outputDir, "server", "node_modules", "ext"), {
      exports: "./index.js",
      files: ["index.js"],
    });

    await expect(check(outputDir, { static: ["ext/extra"] })).rejects.toThrow(
      missingExternal("ext/extra"),
    );
  });

  it("rejects when the export Node selects is missing from the output", async () => {
    // Node's ESM loader selects `node-addons` by default, while Nitro's tracer
    // copies only the `import` target.
    const outputDir = await createOutput();
    await writePackage(join(outputDir, "server", "node_modules", "ext"), {
      exports: { "node-addons": "./addons.js", import: "./index.js" },
      files: ["index.js"],
    });

    await expect(check(outputDir, { static: ["ext"] })).rejects.toThrow(missingExternal("ext"));
  });

  it("accepts the conditional export Node selects when the output contains it", async () => {
    const outputDir = await createOutput();
    await writePackage(join(outputDir, "server", "node_modules", "ext"), {
      exports: { node: "./node.js", import: "./index.js" },
      files: ["node.js"],
    });

    await expect(check(outputDir, { static: ["ext"] })).resolves.toBeUndefined();
  });

  it("rejects an external that resolves outside the output", async () => {
    // A copied or deployed output cannot follow a link back into the workspace.
    const outputDir = await createOutput();
    const workspacePackage = join(await createScratchDirectory("eve-external-workspace-"), "ext");
    await writePackage(workspacePackage, { exports: "./index.js", files: ["index.js"] });
    await mkdir(join(outputDir, "server", "node_modules"), { recursive: true });
    await symlink(workspacePackage, join(outputDir, "server", "node_modules", "ext"), "dir");

    await expect(check(outputDir, { static: ["ext"] })).rejects.toThrow(missingExternal("ext"));
  });

  it("ignores imports that are not configured externals", async () => {
    const outputDir = await createOutput();

    await expect(check(outputDir, { static: ["bundled-elsewhere"] })).resolves.toBeUndefined();
  });
});
