import { readStampedPackageVersion } from "#internal/application/stamped-package-version.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

// In a browser, eve's version is the one the package build stamped; a page bundled from eve's
// source reports "source". `package-info.ts` is the Node twin, which can read package.json.

/** eve's version, as installed. */
export function installedEveVersion(): string {
  return readStampedPackageVersion() ?? "source";
}

/** eve's package name and version, as installed. */
export function installedEvePackage(): { readonly name: string; readonly version: string } {
  return { name: EVE_PACKAGE_NAME, version: installedEveVersion() };
}
