import { readStampedPackageVersion } from "#internal/application/stamped-package-version.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

export function installedEveVersion(): string {
  return readStampedPackageVersion() ?? "source";
}

export function installedEvePackage(): { readonly name: string; readonly version: string } {
  return { name: EVE_PACKAGE_NAME, version: installedEveVersion() };
}
