import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

describe("package identity", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.doUnmock("node:module");
  });

  it("resolves package identity from the installed package metadata", () => {
    const installedPackageInfo = resolveInstalledPackageInfo();

    expect(EVE_PACKAGE_NAME).toBe(installedPackageInfo.name);
    expect(installedPackageInfo.version).toMatch(/\S/);
  });

  it("falls back to bundled package metadata when runtime chunks have no package root", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
      readFileSync: () => {
        throw new Error("Unexpected package.json read.");
      },
      realpathSync: (path: string) => path,
    }));
    vi.doMock("node:module", () => ({
      createRequire: () => ({
        resolve: () => {
          throw new Error("Package self-resolution unavailable.");
        },
      }),
    }));

    const { resolveInstalledPackageInfo: resolveBundledPackageInfo } =
      await import("#internal/application/package.js");
    const installedPackageInfo = resolveBundledPackageInfo();

    expect(installedPackageInfo.name).toBe(EVE_PACKAGE_NAME);
    expect(installedPackageInfo.version).toMatch(/\S/);
  });
});
