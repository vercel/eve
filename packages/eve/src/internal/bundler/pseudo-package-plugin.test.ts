import { describe, expect, it } from "vitest";

import {
  PSEUDO_PACKAGE_SPECIFIERS,
  createPseudoPackagePlugin,
} from "#internal/bundler/pseudo-package-plugin.js";

describe("createPseudoPackagePlugin", () => {
  it("resolves framework-only marker packages to empty virtual modules", () => {
    const plugin = createPseudoPackagePlugin();

    for (const specifier of PSEUDO_PACKAGE_SPECIFIERS) {
      const resolved = plugin.resolveId(specifier);

      expect(resolved).toEqual({
        id: `\0eve-pseudo-package:${specifier}`,
      });
      expect(plugin.load(resolved?.id ?? "")).toEqual({
        code: "",
        moduleType: "js",
      });
    }
  });

  it("leaves ordinary packages and unrelated virtual modules untouched", () => {
    const plugin = createPseudoPackagePlugin();

    expect(plugin.resolveId("zod")).toBeUndefined();
    expect(plugin.load("\0another-plugin:server-only")).toBeUndefined();
  });
});
