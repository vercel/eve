import { describe, expect, it, vi } from "vitest";

import { importInstalledEnginePackage } from "#internal/application/optional-package-import.js";
import { createSandboxProviderHost } from "#execution/sandbox/provider-host.js";

vi.mock("#internal/application/optional-package-import.js", () => ({
  importInstalledEnginePackage: vi.fn(),
}));

const mockedImportInstalledEnginePackage = vi.mocked(importInstalledEnginePackage);

describe("createSandboxProviderHost", () => {
  it("loads an application-installed package after its bundled import fails", async () => {
    const loadedModule = { ok: true };
    mockedImportInstalledEnginePackage.mockResolvedValueOnce(loadedModule);
    const host = createSandboxProviderHost("/repo/app");

    await expect(
      host.loadOptionalPackage({
        autoInstall: true,
        importModule: async () => {
          throw new Error("bundled dependency missing");
        },
        missingMessage: "missing dependency",
        packageName: "dependency",
      }),
    ).resolves.toBe(loadedModule);

    expect(mockedImportInstalledEnginePackage).toHaveBeenCalledWith({
      appRoot: "/repo/app",
      packageName: "dependency",
    });
  });
});
