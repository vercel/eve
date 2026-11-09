import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAuthoredPlugins } from "#internal/bundler/authored-plugins.js";
import { buildSingleRolldownChunk } from "#internal/bundler/rolldown.js";

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function writePackage(root: string, files: Record<string, string>): void {
  mkdirSync(root, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(root, file), content);
}

/**
 * An app whose generated entry imports an installed package by its resolved path, as hosted
 * builds' generated modules do. The package and one of its dependencies import text assets.
 */
function createHostBundledPackageApp(): { entry: string; packageRoot: string; appRoot: string } {
  const appRoot = realpathSync(mkdtempSync(join(tmpdir(), "eve-host-bundled-assets-")));
  scratchRoots.push(appRoot);
  writeFileSync(join(appRoot, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  const nodeModules = join(appRoot, "node_modules");
  writePackage(join(nodeModules, "prompt-pack"), {
    "index.js": [
      'import prompt from "./prompt.txt?raw";',
      'import footer from "footer-pack";',
      "export default `${prompt}${footer}`;",
      "",
    ].join("\n"),
    "package.json": JSON.stringify({
      dependencies: { "footer-pack": "1.0.0" },
      main: "index.js",
      name: "prompt-pack",
      type: "module",
    }),
    "prompt.txt": "prompt-pack-text\n",
  });
  writePackage(join(nodeModules, "footer-pack"), {
    "footer.txt": "footer-pack-text\n",
    "index.js": 'import footer from "./footer.txt?raw";\nexport default footer;\n',
    "package.json": JSON.stringify({ main: "index.js", name: "footer-pack", type: "module" }),
  });
  const packageRoot = join(nodeModules, "prompt-pack");
  const entry = join(appRoot, "generated.mjs");
  writeFileSync(
    entry,
    `import prompt from ${JSON.stringify(join(packageRoot, "index.js"))};\nexport { prompt };\n`,
  );
  return { appRoot, entry, packageRoot };
}

/**
 * An app whose generated entry imports a store-installed TypeScript source package by its
 * resolved path, outside the app package as in a workspace's pnpm store. The package resolves
 * `~/*` through its own tsconfig `paths`.
 */
function createHostBundledAliasApp(): { entry: string; packageRoot: string; appRoot: string } {
  const appRoot = realpathSync(mkdtempSync(join(tmpdir(), "eve-host-bundled-aliases-")));
  const storeRoot = realpathSync(mkdtempSync(join(tmpdir(), "eve-host-bundled-alias-store-")));
  scratchRoots.push(appRoot, storeRoot);
  writeFileSync(join(appRoot, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  const packageRoot = join(storeRoot, "node_modules", "alias-pack");
  writePackage(packageRoot, {
    "index.ts": 'export { value } from "~/value";\n',
    "package.json": JSON.stringify({ main: "index.ts", name: "alias-pack", type: "module" }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "~/*": ["./src/*"] } } }),
  });
  writePackage(join(packageRoot, "src"), {
    "value.ts": 'export const value: string = "alias-pack-value";\n',
  });
  const entry = join(appRoot, "generated.mjs");
  writeFileSync(entry, `export { value } from ${JSON.stringify(join(packageRoot, "index.ts"))};\n`);
  return { appRoot, entry, packageRoot };
}

describe("createAuthoredPlugins for builds that bundle installed dependencies", () => {
  it("loads assets of host-bundled packages and the packages they load", async () => {
    const { appRoot, entry, packageRoot } = createHostBundledPackageApp();

    const chunk = await buildSingleRolldownChunk("host-bundled assets", {
      input: entry,
      output: { format: "esm" },
      plugins: createAuthoredPlugins({
        authoredSourceOnly: true,
        hostBundledPackageRoots: [packageRoot],
        packageRoot: appRoot,
      }),
    });

    expect(chunk.code).toContain("prompt-pack-text");
    expect(chunk.code).toContain("footer-pack-text");
  });

  it("leaves other installed packages' imports to the bundler", async () => {
    const { appRoot, entry } = createHostBundledPackageApp();

    await expect(
      buildSingleRolldownChunk("installed assets without host bundling", {
        input: entry,
        output: { format: "esm" },
        plugins: createAuthoredPlugins({ authoredSourceOnly: true, packageRoot: appRoot }),
      }),
    ).rejects.toThrow(/prompt\.txt\?raw/);
  });

  it("resolves host-bundled source packages' own tsconfig paths", async () => {
    const { appRoot, entry, packageRoot } = createHostBundledAliasApp();
    const build = (hostBundledPackageRoots?: readonly string[]) =>
      buildSingleRolldownChunk("host-bundled tsconfig paths", {
        input: entry,
        output: { format: "esm" },
        plugins: createAuthoredPlugins({
          authoredSourceOnly: true,
          hostBundledPackageRoots,
          packageRoot: appRoot,
        }),
      });

    expect((await build([packageRoot])).code).toContain("alias-pack-value");
    const withoutScope = await build().then(
      (chunk) => chunk.code,
      (error: unknown) => String(error),
    );
    expect(withoutScope).not.toContain("alias-pack-value");
  });
});
