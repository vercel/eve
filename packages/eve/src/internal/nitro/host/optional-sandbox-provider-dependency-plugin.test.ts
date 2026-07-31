import { describe, expect, it } from "vitest";

import { createOptionalSandboxProviderDependencyPlugin } from "#internal/nitro/host/optional-sandbox-provider-dependency-plugin.js";

describe("createOptionalSandboxProviderDependencyPlugin", () => {
  it("returns null when every optional sandbox provider is configured", () => {
    expect(createOptionalSandboxProviderDependencyPlugin([])).toBeNull();
  });

  it("pins unconfigured provider packages as plain externals", () => {
    const plugin = createOptionalSandboxProviderDependencyPlugin(["just-bash", "microsandbox"]);

    expect(plugin?.resolveId?.("just-bash", undefined)).toEqual({
      external: true,
      id: "just-bash",
    });
    expect(plugin?.resolveId?.("microsandbox", undefined)).toEqual({
      external: true,
      id: "microsandbox",
    });
  });

  it("leaves every other specifier untouched", () => {
    const plugin = createOptionalSandboxProviderDependencyPlugin(["just-bash"]);

    expect(plugin?.resolveId?.("zod", undefined)).toBeNull();
    expect(plugin?.resolveId?.("microsandbox", undefined)).toBeNull();
    expect(plugin?.resolveId?.("just-bash/browser", undefined)).toBeNull();
  });
});
