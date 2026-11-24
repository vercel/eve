import { resolveInstalledPackageInfo } from "#internal/application/package.js";

export function installedEveVersion(): string {
  return resolveInstalledPackageInfo().version;
}

export function installedEvePackage(): { readonly name: string; readonly version: string } {
  const { name, version } = resolveInstalledPackageInfo();
  return { name, version };
}
