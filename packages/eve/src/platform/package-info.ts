import { resolveInstalledPackageInfo } from "#internal/application/package.js";

// eve's own version, for a session's runtime identity. `package-info.web.ts` is the browser's
// twin, which has no package.json to read; the package's `#platform/*` imports pick one by the
// `node` condition.

/** eve's version, as installed. */
export function installedEveVersion(): string {
  return resolveInstalledPackageInfo().version;
}

/** eve's package name and version, as installed. */
export function installedEvePackage(): { readonly name: string; readonly version: string } {
  const { name, version } = resolveInstalledPackageInfo();
  return { name, version };
}
