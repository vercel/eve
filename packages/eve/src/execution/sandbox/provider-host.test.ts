import { describe, expect, it, vi } from "vitest";

import { loadOptionalEnginePackage } from "#internal/application/optional-package-install.js";
import { createSandboxProviderHost } from "#execution/sandbox/provider-host.js";

vi.mock("#internal/application/optional-package-install.js", () => ({
  loadOptionalEnginePackage: vi.fn(async (input) => input),
}));

const mockedLoadOptionalEnginePackage = vi.mocked(loadOptionalEnginePackage);

describe("createSandboxProviderHost", () => {
  it.each([
    [true, true],
    [false, false],
  ])("applies its installation policy (allow: %s)", async (allowInstall, autoInstall) => {
    const host = createSandboxProviderHost({ allowInstall, appRoot: "/repo/app" });
    const request = {
      autoInstall: true,
      importModule: async () => ({ ok: true }),
      missingMessage: "missing dependency",
      packageName: "dependency",
    };

    await host.loadOptionalPackage(request);

    expect(mockedLoadOptionalEnginePackage).toHaveBeenCalledWith({
      ...request,
      appRoot: "/repo/app",
      autoInstall,
    });
  });
});
