export function stripNpmPackageScope(packageName: string): string {
  const slashIndex = packageName.lastIndexOf("/");
  return slashIndex === -1 ? packageName : packageName.slice(slashIndex + 1);
}
