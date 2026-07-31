import { describe, expect, it } from "vitest";

import { shouldPruneLocalSandboxProviders } from "#internal/nitro/host/create-application-nitro.js";

describe("shouldPruneLocalSandboxProviders", () => {
  it("prunes local providers when no authored definition can select one", () => {
    expect(
      shouldPruneLocalSandboxProviders({
        configuredProviders: new Set(),
        preset: "vercel",
      }),
    ).toBe(true);
  });

  it("keeps local backends when a local backend is configured explicitly", () => {
    for (const provider of ["docker", "microsandbox", "just-bash"]) {
      expect(
        shouldPruneLocalSandboxProviders({
          configuredProviders: new Set([provider]),
          preset: "vercel",
        }),
      ).toBe(false);
    }
  });

  it("still prunes local backends when only Vercel or custom backends are configured", () => {
    expect(
      shouldPruneLocalSandboxProviders({
        configuredProviders: new Set(["vercel", "custom"]),
        preset: "vercel",
      }),
    ).toBe(true);
  });

  it("does not prune local backends for non-Vercel presets", () => {
    expect(
      shouldPruneLocalSandboxProviders({
        configuredProviders: new Set(),
        preset: undefined,
      }),
    ).toBe(false);
  });
});
