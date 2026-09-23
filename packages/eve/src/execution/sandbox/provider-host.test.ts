import { describe, expect, it, vi } from "vitest";

import { importInstalledEnginePackage } from "#internal/application/optional-package-import.js";
import { createSandboxProviderHost } from "#execution/sandbox/provider-host.js";

vi.mock("#internal/application/optional-package-import.js", () => ({
  importInstalledEnginePackage: vi.fn(),
}));

const mockedImportInstalledEnginePackage = vi.mocked(importInstalledEnginePackage);

const request = {
  autoInstall: true,
  importModule: vi.fn(async () => {
    throw new Error("bundled dependency missing");
  }),
  missingMessage: "missing dependency",
  packageName: "dependency",
};

describe("createSandboxProviderHost", () => {
  it("loads application-installed packages without bundling the development installer", async () => {
    const loadedModule = { ok: true };
    mockedImportInstalledEnginePackage.mockResolvedValueOnce(loadedModule);
    const host = createSandboxProviderHost({ appRoot: "/repo/app" });

    await expect(host.loadOptionalPackage(request)).resolves.toBe(loadedModule);

    expect(mockedImportInstalledEnginePackage).toHaveBeenCalledWith({
      appRoot: "/repo/app",
      packageName: "dependency",
    });
  });

  it("delegates package loading when development preparation allows installation", async () => {
    const loadOptionalPackage = vi.fn(async (input) => input);
    const host = createSandboxProviderHost({
      appRoot: "/repo/app",
      loadOptionalPackage,
    });

    await host.loadOptionalPackage(request);

    expect(loadOptionalPackage).toHaveBeenCalledWith({
      ...request,
      appRoot: "/repo/app",
    });
  });
});
