/**
 * Removes the npm scope prefix from a package name when present.
 */
export function stripNpmPackageScope(packageName: string): string {
  const slashIndex = packageName.lastIndexOf("/");
  return slashIndex === -1 ? packageName : packageName.slice(slashIndex + 1);
}
