import { fileURLToPath } from "node:url";

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

  it("falls back to bundled package metadata without runtime package resolution", async () => {
    vi.resetModules();
    const resolvePackageJson = vi.fn(() => {
      throw new Error("Unexpected package self-resolution.");
    });
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
      readFileSync: () => {
        throw new Error("Unexpected package.json read.");
      },
      realpathSync: (path: string) => path,
    }));
    vi.doMock("node:module", () => ({
      createRequire: () => ({
        resolve: resolvePackageJson,
      }),
    }));

    const { resolveInstalledPackageInfo: resolveBundledPackageInfo } =
      await import("#internal/application/package.js");
    const installedPackageInfo = resolveBundledPackageInfo();

    expect(installedPackageInfo.name).toBe(EVE_PACKAGE_NAME);
    expect(installedPackageInfo.version).toBe("0.0.0");
    expect(resolvePackageJson).not.toHaveBeenCalled();
  });

  it("does not use metadata from a surrounding package that does not own the module", async () => {
    vi.resetModules();
    const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const realpathSync = Object.assign((path: string) => path, {
      native: (path: string) => path,
    });
    const readPackageJson = vi.fn((path: string) => {
      if (path === packageJsonPath) {
        return JSON.stringify({ name: EVE_PACKAGE_NAME, version: "9.9.9" });
      }

      throw new Error("File not found.");
    });
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
      readFileSync: readPackageJson,
      realpathSync,
    }));

    const { resolveInstalledPackageInfo: resolveBundledPackageInfo } =
      await import("#internal/application/package.js");

    expect(resolveBundledPackageInfo()).toEqual({
      name: EVE_PACKAGE_NAME,
      version: "0.0.0",
    });
    expect(readPackageJson).not.toHaveBeenCalled();
  });
});
