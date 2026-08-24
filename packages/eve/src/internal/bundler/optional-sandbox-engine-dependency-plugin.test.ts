import { describe, expect, it } from "vitest";

import { createOptionalSandboxEngineDependencyPlugin } from "#internal/bundler/optional-sandbox-engine-dependency-plugin.js";

describe("createOptionalSandboxEngineDependencyPlugin", () => {
  it("returns null when every optional engine follows another packaging path", () => {
    expect(createOptionalSandboxEngineDependencyPlugin([])).toBeNull();
  });

  it("pins selected engine packages as explicit externals", () => {
    const plugin = createOptionalSandboxEngineDependencyPlugin(["just-bash", "microsandbox"]);

    expect(plugin?.resolveId?.("just-bash", undefined)).toEqual({
      external: true,
      id: "just-bash",
    });
    expect(plugin?.resolveId?.("microsandbox", undefined)).toEqual({
      external: true,
      id: "microsandbox",
    });
  });

  it("leaves unselected packages and engine subpaths alone", () => {
    const plugin = createOptionalSandboxEngineDependencyPlugin(["just-bash"]);

    expect(plugin?.resolveId?.("microsandbox", undefined)).toBeNull();
    expect(plugin?.resolveId?.("just-bash/browser", undefined)).toBeNull();
  });
});
