import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

describe("package identity", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.doUnmock("node:module");
    vi.doUnmock("#internal/application/stamped-package-version.js");
  });

  it("resolves package identity from the installed package metadata", () => {
    const installedPackageInfo = resolveInstalledPackageInfo();

    expect(EVE_PACKAGE_NAME).toBe(installedPackageInfo.name);
    expect(installedPackageInfo.version).toMatch(/\S/);
  });

  it("uses the stamped version in bundled output without runtime package resolution", async () => {
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
    vi.doMock("#internal/application/stamped-package-version.js", () => ({
      readStampedPackageVersion: () => "1.2.3",
    }));

    const { resolveInstalledPackageInfo: resolveBundledPackageInfo } =
      await import("#internal/application/package.js");
    const installedPackageInfo = resolveBundledPackageInfo();

    expect(installedPackageInfo.name).toBe(EVE_PACKAGE_NAME);
    expect(installedPackageInfo.version).toBe("1.2.3");
    expect(resolvePackageJson).not.toHaveBeenCalled();
  });

  it("resolves the workspace package for an unstamped source bundle", async () => {
    vi.resetModules();
    const workspacePackageJsonPath = "/workspace/node_modules/eve/package.json";
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
      readFileSync: (path: string) => {
        if (path === workspacePackageJsonPath) {
          return JSON.stringify({ name: EVE_PACKAGE_NAME, version: "4.5.6" });
        }

        throw new Error("File not found.");
      },
      realpathSync: Object.assign((path: string) => path, {
        native: (path: string) => path,
      }),
    }));
    vi.doMock("node:module", () => ({
      createRequire: () => ({
        resolve: () => workspacePackageJsonPath,
      }),
    }));
    vi.doMock("#internal/application/stamped-package-version.js", () => ({
      readStampedPackageVersion: () => undefined,
    }));

    const { resolveInstalledPackageInfo: resolveSourcePackageInfo } =
      await import("#internal/application/package.js");

    expect(resolveSourcePackageInfo()).toEqual({
      name: EVE_PACKAGE_NAME,
      version: "4.5.6",
    });
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
    vi.doMock("#internal/application/stamped-package-version.js", () => ({
      readStampedPackageVersion: () => "1.2.3",
    }));

    const { resolveInstalledPackageInfo: resolveBundledPackageInfo } =
      await import("#internal/application/package.js");

    expect(resolveBundledPackageInfo()).toEqual({
      name: EVE_PACKAGE_NAME,
      version: "1.2.3",
    });
    expect(readPackageJson).not.toHaveBeenCalled();
  });
});
