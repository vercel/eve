import { describe, expect, it } from "vitest";

import { shouldPruneLocalSandboxProviders } from "#internal/nitro/host/create-application-nitro.js";

describe("shouldPruneLocalSandboxProviders", () => {
  it("prunes local providers from hosted Vercel builds when the sandbox uses defaultSandbox", () => {
    expect(
      shouldPruneLocalSandboxProviders({
        configuredBackendNames: new Set(),
        preset: "vercel",
      }),
    ).toBe(true);
  });

  it("keeps local providers when a local backend is configured explicitly", () => {
    for (const providerName of ["docker", "microsandbox", "just-bash"]) {
      expect(
        shouldPruneLocalSandboxProviders({
          configuredBackendNames: new Set([providerName]),
          preset: "vercel",
        }),
      ).toBe(false);
    }
  });

  it("still prunes local providers when only Vercel or custom backends are configured", () => {
    expect(
      shouldPruneLocalSandboxProviders({
        configuredBackendNames: new Set(["vercel", "custom"]),
        preset: "vercel",
      }),
    ).toBe(true);
  });

  it("does not prune local providers for non-Vercel presets", () => {
    expect(
      shouldPruneLocalSandboxProviders({
        configuredBackendNames: new Set(),
        preset: undefined,
      }),
    ).toBe(false);
  });
});
