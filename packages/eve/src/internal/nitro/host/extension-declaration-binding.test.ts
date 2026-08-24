import { describe, expect, it } from "vitest";

import { createModuleSourceRef } from "#discover/manifest.js";
import { createExtensionDeclarationBinding } from "#internal/nitro/host/extension-declaration-binding.js";

describe("createExtensionDeclarationBinding", () => {
  it("owns the declaration path, runtime dependencies, and package-stable scope", () => {
    expect(
      createExtensionDeclarationBinding({
        declarationModule: createModuleSourceRef({ logicalPath: "extension.ts" }),
        namespace: "crm",
        packageName: "@acme/crm",
        runtimeDependencies: ["eve", "zod"],
        sourceRoot: "/package/extension",
      }),
    ).toEqual({
      backing: {
        externalDependencies: ["eve", "zod"],
        extensionScope: {
          namespace: "acme-crm",
          sourceRoot: "/package/extension",
        },
        kind: "filesystem",
        sourcePath: "/package/extension/extension.ts",
      },
      logicalPath: "extension.ts",
      owner: {
        kind: "extension",
        namespace: "crm",
        packageName: "@acme/crm",
      },
    });
  });
});
