import { describe, expect, it } from "vitest";

import { createOptionalEngineDependencyPlugin } from "#internal/nitro/host/optional-engine-dependency-plugin.js";

describe("createOptionalEngineDependencyPlugin", () => {
  it("returns null when every optional engine backend is configured", () => {
    expect(createOptionalEngineDependencyPlugin([])).toBeNull();
  });

  it("pins unconfigured engine packages as plain externals", () => {
    const plugin = createOptionalEngineDependencyPlugin(["just-bash", "microsandbox"]);

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
    const plugin = createOptionalEngineDependencyPlugin(["just-bash"]);

    expect(plugin?.resolveId?.("zod", undefined)).toBeNull();
    expect(plugin?.resolveId?.("microsandbox", undefined)).toBeNull();
    expect(plugin?.resolveId?.("just-bash/browser", undefined)).toBeNull();
  });
});
