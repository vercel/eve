import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "rolldown";
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

/**
 * An app whose generated entry imports three host-bundled packages by their resolved paths and
 * one other installed package by name. Two host-bundled packages sit in directories their names
 * do not give away: under a scope, and under an npm alias. The third is linked from outside
 * `node_modules` and loads a module from a directory of its own `node_modules` that names no
 * package. Every package imports a relative module, and the other package imports a further
 * installed package.
 */
function createInstalledPackagesApp(): {
  appRoot: string;
  entry: string;
  hostBundledPackageRoots: string[];
} {
  // The native realpath, which the package scope also takes of its roots: only it expands the
  // 8.3 short name a Windows temporary directory can arrive as.
  const appRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "eve-installed-packages-")));
  scratchRoots.push(appRoot);
  writeFileSync(join(appRoot, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  const installPackage = (directory: string, name: string, imports: string[]): string => {
    const root = join(appRoot, "node_modules", directory);
    writePackage(root, {
      "index.js": `${imports.join("\n")}\n`,
      "package.json": JSON.stringify({ main: "index.js", name, type: "module" }),
      "value.js": `export default ${JSON.stringify(`${name}-value`)};\n`,
    });
    return root;
  };
  const value = 'export { default as value } from "./value.js";';
  const hostBundledPackageRoots = [
    installPackage(join("@acme", "scoped-pack"), "@acme/scoped-pack", [value]),
    installPackage("alias-of-pack", "aliased-pack", [value]),
  ];
  const linkedPackageRoot = join(appRoot, "linked-pack");
  writePackage(linkedPackageRoot, {
    "index.js": 'export * from "./node_modules/unnamed/index.js";\n',
    "package.json": JSON.stringify({ main: "index.js", name: "linked-pack", type: "module" }),
  });
  writePackage(join(linkedPackageRoot, "node_modules", "unnamed"), {
    "index.js": `${value}\n`,
    "value.js": 'export default "unnamed-value";\n',
  });
  hostBundledPackageRoots.push(linkedPackageRoot);
  installPackage("plain-pack", "plain-pack", [
    value,
    'export { value as dependency } from "plain-dependency";',
  ]);
  installPackage("plain-dependency", "plain-dependency", [value]);
  const entry = join(appRoot, "generated.mjs");
  writeFileSync(
    entry,
    [
      ...hostBundledPackageRoots.map(
        (root, index) =>
          `export { value as value${index} } from ${JSON.stringify(join(root, "index.js"))};`,
      ),
      'export { dependency, value } from "plain-pack";',
      "",
    ].join("\n"),
  );
  return { appRoot, entry, hostBundledPackageRoots };
}

/** Records the importer of every `resolveId` call that reaches a plugin's handler. */
function recordHandledImporters(plugins: Plugin[], importers: string[]): Plugin[] {
  return plugins.map((plugin) => {
    const hook = plugin.resolveId;
    if (typeof hook !== "object") return plugin;
    const { handler } = hook;
    return {
      ...plugin,
      resolveId: {
        ...hook,
        handler(source, importer, options) {
          if (importer !== undefined) importers.push(importer);
          return handler.call(this, source, importer, options);
        },
      },
    };
  });
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

  it("hands the resolvers host-bundled packages' imports and no other installed package's", async () => {
    const { appRoot, entry, hostBundledPackageRoots } = createInstalledPackagesApp();
    const importers: string[] = [];

    const chunk = await buildSingleRolldownChunk("host-bundled and other installed packages", {
      input: entry,
      output: { format: "esm" },
      plugins: recordHandledImporters(
        createAuthoredPlugins({
          authoredSourceOnly: true,
          hostBundledPackageRoots,
          packageRoot: appRoot,
        }),
        importers,
      ),
    });

    for (const name of ["@acme/scoped-pack", "aliased-pack", "plain-pack", "plain-dependency"]) {
      expect(chunk.code).toContain(`${name}-value`);
    }
    const handledFrom = (directory: string): boolean =>
      importers.some((importer) => importer.endsWith(join("node_modules", directory, "index.js")));
    expect(handledFrom(join("@acme", "scoped-pack"))).toBe(true);
    expect(handledFrom("alias-of-pack")).toBe(true);
    expect(handledFrom("unnamed")).toBe(true);
    expect(handledFrom("plain-pack")).toBe(false);
    expect(handledFrom("plain-dependency")).toBe(false);
  });
});
