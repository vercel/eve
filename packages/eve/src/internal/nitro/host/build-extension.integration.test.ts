import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildExtensionPackage,
  tryReadExtensionBuildConfig,
} from "#internal/nitro/host/build-extension.js";

// Reading build config and the pre-bundle validation are pure; the bundling
// output is covered by build-extension.scenario.test.ts (it invokes rolldown).
describe("extension build config", () => {
  it("reads eve.extension and derives the short name", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-ext-build-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/crm",
        type: "module",
        eve: { extension: { source: "extension", dist: "dist/extension" } },
      }),
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);
    expect(config).not.toBeNull();
    expect(config?.packageName).toBe("@acme/crm");
    expect(config?.shortName).toBe("crm");
    expect(config?.distRoot).toBe(join(root, "dist", "extension"));
  });

  it("returns null for a regular agent app without eve.extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-app-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "my-agent" }), "utf8");
    expect(await tryReadExtensionBuildConfig(root)).toBeNull();
  });

  it("requires the authoring root to build a dist-only contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-ext-distonly-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/dist-only",
        eve: { extension: { dist: "dist/extension" } },
      }),
      "utf8",
    );
    await expect(tryReadExtensionBuildConfig(root)).rejects.toThrow(/eve\.extension\.source/);
  });

  it("does not accept the legacy string extension root", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-ext-legacy-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "@acme/legacy", eve: { extension: "extension" } }),
      "utf8",
    );
    expect(await tryReadExtensionBuildConfig(root)).toBeNull();
  });

  it("rejects overlapping source and managed output roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-ext-overlap-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/overlap",
        eve: {
          extension: { source: "extension", dist: "extension/dist/runtime" },
        },
      }),
      "utf8",
    );
    await expect(tryReadExtensionBuildConfig(root)).rejects.toThrow(/cannot overlap/);
  });

  it("throws when the extension has no declaration module", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-ext-nodecl-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/nodecl",
        type: "module",
        eve: { extension: { source: "extension", dist: "dist/extension" } },
      }),
      "utf8",
    );
    await mkdir(join(root, "extension", "tools"), { recursive: true });
    await writeFile(
      join(root, "extension", "tools", "ping.mjs"),
      'export default { description: "Ping.", async execute() { return {}; } };\n',
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);
    await expect(buildExtensionPackage(root, config!)).rejects.toThrow(
      /missing an "extension\.<ext>" declaration/,
    );
  });
});
