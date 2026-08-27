import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePackageLocationFromModulePath } from "#internal/application/package.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

// Matches how the resolver canonicalizes paths. Windows temporary roots often
// arrive as 8.3 short names, which only the native realpath expands.
function canonicalize(path: string): string {
  return realpathSync.native(path);
}

async function writeFixtureFile(path: string, contents = ""): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function writePackageManifest(packageRoot: string, name: string): Promise<void> {
  await writeFixtureFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        exports: {
          "./package.json": "./package.json",
        },
        name,
        version: "1.0.0",
      },
      null,
      2,
    )}\n`,
  );
}

async function writeInstalledEvePackage(appRoot: string): Promise<string> {
  const packageRoot = join(appRoot, "node_modules", "eve");

  await writePackageManifest(packageRoot, "eve");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  return packageRoot;
}

async function writeBundle(appRoot: string): Promise<string> {
  const bundlePath = join(appRoot, ".eve", "dev-hosts", "fixture", "nitro", "dev", "index.mjs");

  await writeFixtureFile(bundlePath, "export {};\n");
  return bundlePath;
}

describe("resolvePackageLocationFromModulePath", () => {
  it("resolves an installed eve package from a bundle outside the package root", async () => {
    const appRoot = await createScratchDirectory("eve-package-location-bundle-");
    await writePackageManifest(appRoot, "consumer-app");
    const packageRoot = await writeInstalledEvePackage(appRoot);
    const bundlePath = await writeBundle(appRoot);
    const canonicalPackageRoot = canonicalize(packageRoot);

    expect(resolvePackageLocationFromModulePath(bundlePath)).toEqual({
      packageBuildRoot: join(canonicalPackageRoot, "dist"),
      packageRoot: canonicalPackageRoot,
    });
  });

  it("keeps source checkouts on package source files", async () => {
    const packageRoot = await createScratchDirectory("eve-package-location-source-");
    await writePackageManifest(packageRoot, "eve");
    const modulePath = join(packageRoot, "src", "internal", "application", "package.ts");
    await writeFixtureFile(modulePath, "export {};\n");
    const canonicalPackageRoot = canonicalize(packageRoot);

    expect(resolvePackageLocationFromModulePath(modulePath)).toEqual({
      packageBuildRoot: null,
      packageRoot: canonicalPackageRoot,
    });
  });

  it("keeps direct dist execution on built package files", async () => {
    const packageRoot = await createScratchDirectory("eve-package-location-dist-");
    await writePackageManifest(packageRoot, "eve");
    await writeFixtureFile(
      join(packageRoot, "src", "internal", "application", "package.ts"),
      "export {};\n",
    );
    const modulePath = join(packageRoot, "dist", "src", "internal", "application", "package.js");
    await writeFixtureFile(modulePath, "export {};\n");
    const canonicalPackageRoot = canonicalize(packageRoot);

    expect(resolvePackageLocationFromModulePath(modulePath)).toEqual({
      packageBuildRoot: join(canonicalPackageRoot, "dist"),
      packageRoot: canonicalPackageRoot,
    });
  });

  it("does not treat consumer directory names as source-checkout evidence", async () => {
    const scratchRoot = await createScratchDirectory("eve-package-location-consumer-");
    const appRoot = join(scratchRoot, "packages", "eve", "consumer");
    await writePackageManifest(appRoot, "consumer-app");
    const packageRoot = await writeInstalledEvePackage(appRoot);
    const bundlePath = await writeBundle(appRoot);
    const canonicalPackageRoot = canonicalize(packageRoot);

    expect(resolvePackageLocationFromModulePath(bundlePath)).toEqual({
      packageBuildRoot: join(canonicalPackageRoot, "dist"),
      packageRoot: canonicalPackageRoot,
    });
  });

  it("falls back to a surrounding verified package when module resolution fails", async () => {
    const packageRoot = await createScratchDirectory("eve-package-location-fallback-");
    await writePackageManifest(packageRoot, "eve");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    const bundlePath = await writeBundle(packageRoot);
    const canonicalPackageRoot = canonicalize(packageRoot);

    expect(
      resolvePackageLocationFromModulePath(bundlePath, () => {
        throw new Error("module resolution unavailable");
      }),
    ).toEqual({
      packageBuildRoot: join(canonicalPackageRoot, "dist"),
      packageRoot: canonicalPackageRoot,
    });
  });

  it("rejects unrelated package roots when module resolution fails", async () => {
    const appRoot = await createScratchDirectory("eve-package-location-missing-");
    await writePackageManifest(appRoot, "consumer-app");
    const bundlePath = await writeBundle(appRoot);

    expect(() =>
      resolvePackageLocationFromModulePath(bundlePath, () => {
        throw new Error("module resolution unavailable");
      }),
    ).toThrowError(`Failed to resolve the eve package root from "${bundlePath}".`);
  });

  it("rejects a resolved manifest that does not identify eve", async () => {
    const appRoot = await createScratchDirectory("eve-package-location-invalid-");
    await writePackageManifest(appRoot, "consumer-app");
    const bundlePath = await writeBundle(appRoot);
    const unrelatedPackageRoot = join(appRoot, "node_modules", "not-eve");
    await writePackageManifest(unrelatedPackageRoot, "not-eve");

    expect(() =>
      resolvePackageLocationFromModulePath(bundlePath, () =>
        join(unrelatedPackageRoot, "package.json"),
      ),
    ).toThrowError(`Failed to resolve the eve package root from "${bundlePath}".`);
  });
});
