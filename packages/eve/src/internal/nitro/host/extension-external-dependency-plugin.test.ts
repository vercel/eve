import { describe, expect, it } from "vitest";

import {
  createExtensionExternalDependencyPlugin,
  resolveExtensionExternalDependencyPaths,
} from "#internal/nitro/host/extension-external-dependency-plugin.js";

describe("extension external dependency plugin", () => {
  it("resolves configured packages from the mounted extension", () => {
    const plugin = createExtensionExternalDependencyPlugin([
      {
        externalDependencies: ["zod"],
        sourceRoot: process.cwd(),
      },
    ]);

    expect(plugin?.resolveId("zod")).toEqual({ external: true, id: "zod" });
    expect(plugin?.resolveId("layout-sensitive-runtime-extra")).toBeNull();
    expect(plugin?.resolveId("unconfigured-runtime")).toBeNull();
  });

  it("omits the plugin without extension requirements", () => {
    expect(createExtensionExternalDependencyPlugin([])).toBeNull();
  });

  it("resolves tracer paths from mounted extension packages", () => {
    expect(
      resolveExtensionExternalDependencyPaths([
        { externalDependencies: ["zod"], sourceRoot: process.cwd() },
      ]),
    ).toEqual({ zod: expect.stringMatching(/zod[/\\].*index\.(?:c?js|mjs)$/) });
  });
});
