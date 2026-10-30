import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createExternalsPolicy } from "#internal/nitro/host/externals-policy.js";
import { compileFromMemory } from "#internal/testing/compile-from-memory.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createTemporaryDirectory = useTemporaryDirectories();

describe("createExternalsPolicy", () => {
  it("fully traces mounted extensions' dependencies, resolved from the extension package", async () => {
    const sourceRoot = await realpath(await createTemporaryDirectory("eve-extension-trace-deps-"));
    for (const name of ["zod", "sharp"]) {
      const packageRoot = join(sourceRoot, "node_modules", name);
      await mkdir(join(packageRoot, "lib"), { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({ name, version: "1.0.0", main: "./lib/index.js" }),
      );
      await writeFile(join(packageRoot, "lib", "index.js"), "module.exports = {};\n");
    }
    const { manifest } = await compileFromMemory({
      agent: { build: { externalDependencies: ["sharp"] }, model: "openai/gpt-5.4" },
      agentRoot: "/tmp/weather-agent/agent",
      appRoot: "/tmp/weather-agent",
      model: "openai/gpt-5.4",
      name: "weather-agent",
    });
    manifest.extensionMounts = [
      {
        externalDependencies: ["zod", "sharp"],
        mountId: "extensions/layout",
        mountLogicalPath: "extensions/layout.ts",
        mountSourceId: "extensions/layout.ts",
        mountSourcePath: join(sourceRoot, "layout.ts"),
        namespace: "layout",
        packageName: "layout-extension",
        sourceRoot,
        specifier: "layout-extension",
      },
    ];

    const policy = createExternalsPolicy({ development: false, manifest, preset: undefined });

    expect(policy.traceDeps).toEqual(expect.arrayContaining(["sharp", "zod*", "sharp*"]));
    expect(policy.extensionTracePaths).toEqual({
      sharp: join(sourceRoot, "node_modules", "sharp", "lib", "index.js"),
      zod: join(sourceRoot, "node_modules", "zod", "lib", "index.js"),
    });
  });
});
