import { describe, expect, it } from "vitest";

import { resolveExtensionExternalDependencyPaths } from "#internal/nitro/host/extension-external-dependencies.js";

describe("resolveExtensionExternalDependencyPaths", () => {
  it("resolves package entries from mounted extension packages", () => {
    expect(
      resolveExtensionExternalDependencyPaths([
        { externalDependencies: ["zod"], sourceRoot: process.cwd() },
      ]),
    ).toEqual({ zod: expect.stringMatching(/zod[/\\].*index\.(?:c?js|mjs)$/) });
  });

  it("resolves ESM-only packages without a require export", () => {
    expect(
      resolveExtensionExternalDependencyPaths([
        { externalDependencies: ["emulate"], sourceRoot: process.cwd() },
      ]),
    ).toEqual({ emulate: expect.stringMatching(/emulate[/\\]dist[/\\]api\.js$/) });
  });
});
