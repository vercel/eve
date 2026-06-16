import { describe, expect, it } from "vitest";

import { shouldPruneLocalSandboxBackends } from "#internal/nitro/host/create-application-nitro.js";

describe("shouldPruneLocalSandboxBackends", () => {
  it("prunes local backends from hosted Vercel builds when the sandbox uses defaultSandbox", () => {
    expect(
      shouldPruneLocalSandboxBackends({
        configuredBackendNames: new Set(),
        preset: "vercel",
      }),
    ).toBe(true);
  });

  it("keeps local backends when a local backend is configured explicitly", () => {
    for (const backendName of ["docker", "microsandbox", "just-bash"]) {
      expect(
        shouldPruneLocalSandboxBackends({
          configuredBackendNames: new Set([backendName]),
          preset: "vercel",
        }),
      ).toBe(false);
    }
  });

  it("still prunes local backends when only Vercel or custom backends are configured", () => {
    expect(
      shouldPruneLocalSandboxBackends({
        configuredBackendNames: new Set(["vercel", "custom"]),
        preset: "vercel",
      }),
    ).toBe(true);
  });

  it("does not prune local backends for non-Vercel presets", () => {
    expect(
      shouldPruneLocalSandboxBackends({
        configuredBackendNames: new Set(),
        preset: undefined,
      }),
    ).toBe(false);
  });
});
