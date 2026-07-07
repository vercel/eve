import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildExtensionPackage,
  tryReadExtensionBuildConfig,
} from "#internal/nitro/host/build-extension.js";

async function createExtensionPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-ext-build-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "@acme/crm", type: "module", eve: { extension: "ext" } }),
    "utf8",
  );
  await mkdir(join(root, "ext", "tools"), { recursive: true });
  await writeFile(
    join(root, "ext", "extension.mjs"),
    'import { defineExtension } from "eve/extension";\nexport default defineExtension({ config: {} });\n',
    "utf8",
  );
  await writeFile(
    join(root, "ext", "tools", "crm_search.mjs"),
    'export default { description: "Search the CRM.", async execute() { return {}; } };\n',
    "utf8",
  );
  return root;
}

describe("extension build", () => {
  it("reads eve.extension and derives the short name", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    expect(config).not.toBeNull();
    expect(config?.packageName).toBe("@acme/crm");
    expect(config?.shortName).toBe("crm");
  });

  it("returns null for a regular agent app without eve.extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-app-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "my-agent" }), "utf8");
    expect(await tryReadExtensionBuildConfig(root)).toBeNull();
  });

  it("generates a package index re-exporting the extension declaration and tools", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    const index = await readFile(join(outDir, "index.mjs"), "utf8");
    expect(index).toContain('export { default } from "../ext/extension.mjs"');
    expect(index).toContain('export { default as crm } from "../ext/extension.mjs"');

    const toolsIndex = await readFile(join(outDir, "tools", "index.mjs"), "utf8");
    expect(toolsIndex).toContain(
      'export { default as crm_search } from "../../ext/tools/crm_search.mjs"',
    );
  });

  it("fills the package exports map so authors do not hand-list it", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    await buildExtensionPackage(root, config!);

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(pkg.exports).toEqual({
      ".": "./dist/index.mjs",
      "./tools": "./dist/tools/index.mjs",
    });
  });

  it("re-exports the declaration for a no-config extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-ext-noconfig-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "@acme/gizmo", type: "module", eve: { extension: "ext" } }),
      "utf8",
    );
    await mkdir(join(root, "ext", "tools"), { recursive: true });
    await writeFile(
      join(root, "ext", "extension.mjs"),
      'import { defineExtension } from "eve/extension";\nexport default defineExtension();\n',
      "utf8",
    );
    await writeFile(
      join(root, "ext", "tools", "gizmo_ping.mjs"),
      'export default { description: "Ping.", async execute() { return {}; } };\n',
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    const index = await readFile(join(outDir, "index.mjs"), "utf8");
    expect(index).toContain('export { default } from "../ext/extension.mjs"');
    expect(index).toContain('export { default as gizmo } from "../ext/extension.mjs"');
    expect(index).not.toContain("mounted-extension");
  });

  it("throws when the extension has no declaration module", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-ext-nodecl-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "@acme/nodecl", type: "module", eve: { extension: "ext" } }),
      "utf8",
    );
    await mkdir(join(root, "ext", "tools"), { recursive: true });
    await writeFile(
      join(root, "ext", "tools", "ping.mjs"),
      'export default { description: "Ping.", async execute() { return {}; } };\n',
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);
    await expect(buildExtensionPackage(root, config!)).rejects.toThrow(
      /missing an "extension\.<ext>" declaration/,
    );
  });

  it("leaves a deliberately customized export entry untouched", async () => {
    const root = await createExtensionPackage();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/crm",
        type: "module",
        eve: { extension: "ext" },
        exports: { ".": "./custom/entry.mjs" },
      }),
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);
    await buildExtensionPackage(root, config!);

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(pkg.exports?.["."]).toBe("./custom/entry.mjs");
    expect(pkg.exports?.["./tools"]).toBe("./dist/tools/index.mjs");
  });
});
