import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildExtensionPackage,
  tryReadExtensionBuildConfig,
} from "#internal/nitro/host/build-extension.js";

// `buildExtensionPackage` bundles the entrypoints with rolldown, so these live in
// the scenario tier. They guard the publishing contract: the Node-facing exports
// must be self-contained runnable JS (no `.ts`/`../extension` source reachable, or an
// installed package fails under node_modules type-stripping), with the extension
// namespace baked in and declarations emitted.
async function createExtensionPackage(pkg?: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-ext-scenario-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "@acme/crm", type: "module", eve: { extension: "extension" }, ...pkg }),
    "utf8",
  );
  await mkdir(join(root, "extension", "tools"), { recursive: true });
  await writeFile(
    join(root, "extension", "extension.ts"),
    'import { defineExtension } from "eve/extension";\nexport default defineExtension();\n',
    "utf8",
  );
  await writeFile(
    join(root, "extension", "tools", "crm_search.ts"),
    'export default { description: "Search the CRM.", async execute() { return {}; } };\n',
    "utf8",
  );
  return root;
}

describe("extension build output", () => {
  it("emits self-contained, namespace-scoped runnable entrypoints", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    const index = await readFile(join(outDir, "index.mjs"), "utf8");
    // Bundled from source: no `.ts`/`../extension` re-export Node would follow natively.
    expect(index).not.toMatch(/from\s+["']\.\.\/ext\//);
    // `eve/*` stays external (resolves to the consumer's eve); namespace baked in.
    expect(index).toMatch(/from\s+["']eve\/extension["']/);
    expect(index).toContain("acme-crm");

    const toolsIndex = await readFile(join(outDir, "tools", "index.mjs"), "utf8");
    expect(toolsIndex).not.toMatch(/from\s+["']\.\.\/\.\.\/ext\//);
    expect(toolsIndex).toContain("Search the CRM"); // the tool source was inlined
  });

  it("emits declaration barrels resolving into the shipped source", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    const indexDts = await readFile(join(outDir, "index.d.ts"), "utf8");
    expect(indexDts).toContain('export { default } from "../extension/extension.js"');
    expect(indexDts).toContain('export { default as crm } from "../extension/extension.js"');

    const toolsDts = await readFile(join(outDir, "tools", "index.d.ts"), "utf8");
    expect(toolsDts).toContain(
      'export { default as crm_search } from "../../extension/tools/crm_search.js"',
    );
  });

  it("sanitizes kebab-case tool names into valid export bindings", async () => {
    const root = await createExtensionPackage();
    await writeFile(
      join(root, "extension", "tools", "get-weather.ts"),
      'export default { description: "Get the weather.", async execute() { return {}; } };\n',
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    const toolsDts = await readFile(join(outDir, "tools", "index.d.ts"), "utf8");
    expect(toolsDts).toContain("as get_weather ");
    expect(toolsDts).not.toContain("as get-weather ");
  });

  it("fills the exports map with runnable + types conditions", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    await buildExtensionPackage(root, config!);

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    expect(pkg.exports).toEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.mjs" },
      "./tools": { types: "./dist/tools/index.d.ts", default: "./dist/tools/index.mjs" },
    });
  });

  it("upgrades a stale bare-string export entry to the runnable + types shape", async () => {
    const root = await createExtensionPackage({ exports: { ".": "./dist/index.mjs" } });
    const config = await tryReadExtensionBuildConfig(root);
    await buildExtensionPackage(root, config!);

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    expect(pkg.exports?.["."]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.mjs" });
  });
});
